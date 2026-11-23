/*
 * FNF Chromatic Scale Generator — núcleo de processamento de áudio.
 * Funciona no navegador (window.ChromaDSP) e no Node (require), sem dependências.
 *
 * Pipeline:
 *   1. analyzeTrack  : rastreia o pitch (YIN) quadro a quadro
 *   2. findSegments  : acha trechos vozeados e estáveis ("Auto-Corte")
 *   3. makeNote      : reamostra (sinc janelado) até o pitch exato da tecla,
 *                      estende com loop de fase casada e aplica fades
 *   4. encodeWav / buildZip / buildSfz : exportação
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChromaDSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
  // flOctave=true  -> convenção do FL Studio (MIDI 60 = C5)
  // flOctave=false -> convenção padrão       (MIDI 60 = C4)
  function noteName(m, flOctave) {
    const oct = Math.floor(m / 12) - (flOctave === false ? 1 : 0);
    return NOTE_NAMES[((m % 12) + 12) % 12] + oct;
  }

  /* ------------------------------------------------------------------ */
  /* Detecção de pitch (YIN)                                             */
  /* ------------------------------------------------------------------ */
  function yin(x, start, W, sr, fmin, fmax, thresh) {
    thresh = thresh || 0.15;
    const tauMin = Math.max(2, Math.floor(sr / fmax));
    const tauMax = Math.ceil(sr / fmin);
    if (start + W + tauMax + 1 > x.length) return { f0: 0, conf: 0 };
    const c = new Float64Array(tauMax + 2);
    let run = 0;
    c[0] = 1;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const e = x[start + j] - x[start + j + tau];
        s += e * e;
      }
      run += s;
      c[tau] = run > 1e-12 ? (s * tau) / run : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (c[t] < thresh) {
        while (t + 1 <= tauMax && c[t + 1] < c[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin; t <= tauMax; t++) if (c[t] < c[best]) best = t;
      if (c[best] > 0.4) return { f0: 0, conf: 0 };
      tau = best;
    }
    let t0 = tau;
    if (tau > 1 && tau <= tauMax) {
      const a = c[tau - 1], b = c[tau], g = c[tau + 1];
      const den = a - 2 * b + g;
      if (Math.abs(den) > 1e-12) t0 = tau + (0.5 * (a - g)) / den;
    }
    return { f0: sr / t0, conf: 1 - Math.min(1, c[tau]) };
  }

  function median(arr) {
    const a = Array.from(arr).sort((p, q) => p - q);
    const n = a.length;
    if (!n) return 0;
    return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }

  /** Estimativa fina de f0 de um trecho [a,b) na taxa original. */
  function refineF0(x, sr, a, b, f0est) {
    const fmin = f0est * 0.85, fmax = f0est * 1.18;
    const tauMax = Math.ceil(sr / fmin);
    let W = Math.min(2048, b - a - tauMax - 2);
    if (W < sr / f0est * 1.5) {
      // trecho curto: usa a janela inteira que couber
      W = Math.max(Math.floor(sr / f0est * 1.5), 32);
      if (a + W + tauMax + 2 > x.length) return f0est;
    }
    const step = Math.max(64, W >> 1);
    const vals = [];
    for (let p = a; p + W + tauMax + 2 <= Math.max(b, a + W + tauMax + 2); p += step) {
      const r = yin(x, p, W, sr, fmin, fmax, 0.2);
      if (r.f0 > 0 && r.conf > 0.8 && Math.abs(r.f0 / f0est - 1) < 0.04) vals.push(r.f0);
      if (vals.length > 40) break;
    }
    return vals.length ? median(vals) : f0est;
  }

  /**
   * Rastreia o pitch. Retorna quadros com f0 (Hz, 0 = sem voz), conf e rms,
   * além dos índices (na taxa original) de início/fim de cada janela.
   */
  async function analyzeTrack(mono, sr, o) {
    o = Object.assign({ fmin: 65, fmax: 900, onProgress: null }, o || {});
    const dec = Math.max(1, Math.round(sr / 16000));
    const asr = sr / dec;
    const n = Math.floor(mono.length / dec);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < dec; k++) s += mono[i * dec + k];
      y[i] = s / dec;
    }
    const tauMax = Math.ceil(asr / o.fmin);
    const W = Math.max(Math.round(asr * 0.032), tauMax);
    const hop = Math.max(1, Math.round(asr * 0.01));
    const frames = { f0: [], conf: [], rms: [], start: [], end: [], dec, hop: hop * dec };
    let count = 0;
    for (let pos = 0; pos + W + tauMax + 2 < n; pos += hop) {
      const r = yin(y, pos, W, asr, o.fmin, o.fmax, 0.15);
      let e = 0;
      for (let j = 0; j < W; j++) e += y[pos + j] * y[pos + j];
      frames.f0.push(r.f0);
      frames.conf.push(r.conf);
      frames.rms.push(Math.sqrt(e / W));
      frames.start.push(pos * dec);
      frames.end.push((pos + W) * dec);
      if (++count % 40 === 0) {
        if (o.onProgress) o.onProgress(pos / n);
        await tick();
      }
    }
    return frames;
  }

  /**
   * Auto-Corte: devolve trechos estáveis e vozeados, do melhor para o pior.
   * Cada trecho é um "núcleo" [a,b) (sem ataque/final, cortado em cruzamento
   * por zero) com f0 refinado em alta resolução.
   */
  function findSegments(mono, sr, tr, o) {
    o = Object.assign({
      minDur: 0.09, maxStd: 40, minConf: 0.82, rmsRel: 0.08,
      maxJump: 0.45, trim: 0.15, maxSegments: 12, fmin: 65, fmax: 900,
    }, o || {});
    const N = tr.f0.length;
    let peak = 0;
    for (let i = 0; i < N; i++) if (tr.rms[i] > peak) peak = tr.rms[i];
    const thr = peak * o.rmsRel;
    const voiced = new Uint8Array(N);
    const m = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      voiced[i] = tr.f0[i] > 0 && tr.conf[i] >= o.minConf && tr.rms[i] >= thr ? 1 : 0;
      m[i] = voiced[i] ? freqToMidi(tr.f0[i]) : 0;
    }
    const runs = [];
    let i = 0;
    while (i < N) {
      if (!voiced[i]) { i++; continue; }
      let j = i;
      const recent = [m[i]];
      while (j + 1 < N && voiced[j + 1]) {
        const ref = recent.reduce((p, q) => p + q, 0) / recent.length;
        if (Math.abs(m[j + 1] - ref) > o.maxJump) break;
        j++;
        recent.push(m[j]);
        if (recent.length > 5) recent.shift();
      }
      runs.push([i, j]);
      i = j + 1;
    }
    const segs = [];
    for (const [i0, j0] of runs) {
      const len = j0 - i0 + 1;
      const cut = Math.floor(len * o.trim);
      const ci = i0 + cut, cj = j0 - cut;
      if (cj <= ci) continue;
      let a = tr.start[ci] + Math.round((tr.end[ci] - tr.start[ci]) * 0.5);
      let b = tr.end[cj];
      if ((b - a) / sr < o.minDur) continue;
      const ms = [], cf = [];
      for (let k = ci; k <= cj; k++) { ms.push(m[k]); cf.push(tr.conf[k]); }
      const med = median(ms);
      const mean = ms.reduce((p, q) => p + q, 0) / ms.length;
      const std = Math.sqrt(ms.reduce((p, q) => p + (q - mean) * (q - mean), 0) / ms.length) * 100;
      if (std > o.maxStd) continue;
      a = snapZero(mono, a, Math.round(sr * 0.002));
      b = snapZero(mono, b, Math.round(sr * 0.002));
      if (b - a < 64) continue;
      const f0est = midiToFreq(med);
      const f0 = refineF0(mono, sr, a, b, f0est);
      const confMean = cf.reduce((p, q) => p + q, 0) / cf.length;
      const dur = (b - a) / sr;
      const score = Math.min(dur, 0.6) * confMean / (1 + std / 15);
      segs.push({ a, b, f0, midi: freqToMidi(f0), dur, stdCents: std, conf: confMean, score });
    }
    segs.sort((p, q) => q.score - p.score);
    const out = segs.slice(0, o.maxSegments);
    const best = out.length ? out[0].score : 1;
    out.forEach((s) => { s.scoreNorm = s.score / best; });
    return out;
  }

  // Move o índice para o cruzamento por zero ascendente mais próximo.
  function snapZero(x, idx, radius) {
    let best = idx, bestD = Infinity;
    for (let k = Math.max(1, idx - radius); k < Math.min(x.length - 1, idx + radius); k++) {
      if (x[k - 1] <= 0 && x[k] > 0 && Math.abs(k - idx) < bestD) { best = k; bestD = Math.abs(k - idx); }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Reamostragem de alta qualidade + geração de notas                    */
  /* ------------------------------------------------------------------ */
  const ZC = 12, RES = 256;
  const SINC = (() => {
    const t = new Float32Array(ZC * RES + 2);
    for (let i = 0; i < t.length; i++) {
      const u = i / RES;
      const s = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
      const w = u < ZC ? 0.42 + 0.5 * Math.cos((Math.PI * u) / ZC) + 0.08 * Math.cos((2 * Math.PI * u) / ZC) : 0;
      t[i] = s * w;
    }
    return t;
  })();

  /** y[i] = x(start + i*step), com filtro anti-aliasing quando step > 1. */
  function resample(x, start, step, outLen) {
    const c = Math.min(1, 1 / step);
    const half = ZC / c;
    const n = x.length;
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = start + i * step;
      const k0 = Math.max(0, Math.ceil(pos - half));
      const k1 = Math.min(n - 1, Math.floor(pos + half));
      let s = 0;
      for (let k = k0; k <= k1; k++) {
        const u = Math.abs(k - pos) * c * RES;
        const j = u | 0;
        const w = SINC[j] + (SINC[j + 1] - SINC[j]) * (u - j);
        s += x[k] * w;
      }
      out[i] = s * c;
    }
    return out;
  }

  /** Estende y até N amostras repetindo a cauda com loop de fase casada. */
  function extendLoop(y, P, N, sr) {
    const L = y.length;
    const out = new Float32Array(N);
    out.set(y.subarray(0, Math.min(L, N)));
    if (L >= N) return out;
    let x = Math.max(8, Math.min(Math.round(P), Math.round(0.01 * sr)));
    x = Math.max(4, Math.min(x, Math.floor(L / 3)));
    const Dmax = L - x;
    if (Dmax < 4) { // trecho minúsculo: apenas repete
      for (let i = L; i < N; i++) out[i] = y[i % L];
      return out;
    }
    const minLoop = Math.round(0.06 * sr);
    const want = Math.min(Dmax, Math.max(minLoop, Math.round(P * 2)));
    let K = Math.max(1, Math.round(want / P));
    if (K * P > Dmax) K = Math.max(1, Math.floor(Dmax / P));
    const Dc = K * P;
    const e = L;
    let bestD = Math.min(Dmax, Math.max(1, Math.round(Dc))), bestC = -Infinity;
    const lo = Math.floor(Dc - P / 2), hi = Math.ceil(Dc + P / 2);
    for (let D = lo; D <= hi; D++) {
      if (D < 1 || D > Dmax) continue;
      const a = e - D;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < x; i++) {
        const p = y[e - x + i], q = y[a - x + i];
        sxy += p * q; sxx += p * p; syy += q * q;
      }
      const corr = sxy / (Math.sqrt(sxx * syy) + 1e-12);
      if (corr > bestC) { bestC = corr; bestD = D; }
    }
    const D = bestD, a = e - D;
    let pos = L;
    while (pos < N) {
      for (let i = 0; i < x; i++) {
        const t = (i + 0.5) / x;
        const idx = pos - x + i;
        if (idx >= 0 && idx < N) out[idx] = y[e - x + i] * (1 - t) + y[a - x + i] * t;
      }
      const m = Math.min(D, N - pos);
      for (let i = 0; i < m; i++) out[pos + i] = y[a + i];
      pos += D;
    }
    return out;
  }


  /* ------------------------------------------------------------------ */
  /* PSOLA: muda o tom preservando o timbre (formantes) da voz            */
  /* ------------------------------------------------------------------ */
  const OS = 4; // super-amostragem: reduz o "tremor" de posicionamento dos grãos

  /** Sobe a fonte 4x e acha as marcas de pitch (um grão por ciclo, por correlação). */
  function prepareSource(src) {
    if (src._prep !== undefined) return src._prep;
    src._prep = null;
    const seg = src.data.subarray(src.a, src.b);
    const n = seg.length;
    if (n < 64 || !(src.f0 > 0)) return null;
    const up = resample(seg, 0, 1 / OS, (n - 1) * OS);
    const T0 = (OS * src.sr) / src.f0;
    const len = Math.round(T0), half = Math.round(T0 / 2), rad = Math.max(2, Math.round(T0 * 0.15));
    const need = Math.round(T0 * 1.25);
    let m = Math.round(T0 * 1.2), best = -Infinity, anchor = m;
    for (let i = m; i < Math.min(up.length - need, m + len); i++) if (up[i] > best) { best = up[i]; anchor = i; }
    const marks = [anchor];
    for (;;) {
      const cur = marks[marks.length - 1];
      const pred = cur + len;
      if (pred + rad + need > up.length) break;
      let bc = -Infinity, bm = pred;
      for (let c = pred - rad; c <= pred + rad; c++) {
        let sxy = 0, syy = 0;
        for (let i = -half; i < half; i += 2) {
          const a = up[cur + i], b = up[c + i];
          sxy += a * b; syy += b * b;
        }
        const corr = sxy / (Math.sqrt(syy) + 1e-9);
        if (corr > bc) { bc = corr; bm = c; }
      }
      marks.push(bm);
    }
    if (marks.length < 3) return null;
    const per = marks.map((v, k) => (k + 1 < marks.length ? marks[k + 1] - v : marks[k] - marks[k - 1]));
    return (src._prep = { up, marks, per, T0 });
  }

  /** Sintetiza com período Tt (na grade super-amostrada) por Ly amostras. */
  function psolaSynth(prep, Tt, Ly) {
    const { up, marks, per } = prep;
    const K = marks.length, cyc = 2 * (K - 1), rate = 0.5;
    const out = new Float32Array(Ly);
    for (let j = 0; ; j++) {
      const t = Math.round(Tt + j * Tt);
      const ph = (j * rate) % cyc;
      const k = Math.round(ph <= K - 1 ? ph : cyc - ph);
      const P = per[k], m = marks[k];
      if (t - P >= Ly) break;
      const g = Tt / P;
      const i0 = Math.max(-P, -t), i1 = Math.min(P, Ly - t);
      for (let i = i0; i < i1; i++) out[t + i] += up[m + i] * (0.5 + 0.5 * Math.cos((Math.PI * i) / P)) * g;
    }
    return out;
  }

  function psolaNote(src, targetF, o) {
    const prep = prepareSource(src);
    if (!prep) return null;
    const r1 = Math.min(2, Math.max(0.5, targetF / src.f0)); // parte feita por PSOLA (±1 oitava)
    const f1 = src.f0 * r1;
    const Tt = (OS * src.sr) / f1;
    const s = (targetF / f1) * ((OS * src.sr) / o.outSr); // resto, por reamostragem
    const N = Math.round(o.noteLen * o.outSr);
    const Ly = Math.ceil((N - 1) * s + ZC * Math.max(1, s) + 4 * Tt + 8);
    const y = psolaSynth(prep, Tt, Ly);
    // descarta o 1º ciclo (ainda sem sobreposição completa) e reamostra
    const start = Math.round(2 * Tt);
    return resample(y, start, s, N);
  }

  /**
   * Gera uma nota a partir de uma fonte.
   * src: { data (mono completo), a, b, f0, sr }   alvo: número MIDI
   */
  function makeNote(src, targetMidi, o) {
    const targetF = midiToFreq(targetMidi);
    const N = Math.round(o.noteLen * o.outSr);
    let out = o.psola === false ? null : psolaNote(src, targetF, o);
    if (!out) {
      const step = (targetF / src.f0) * (src.sr / o.outSr);
      const Lfull = Math.floor((src.b - src.a - 1) / step);
      const Lout = Math.max(8, Math.min(Lfull, N));
      out = resample(src.data, src.a, step, Lout);
      if (Lout < N) out = extendLoop(out, o.outSr / targetF, N, o.outSr);
    }
    const fin = Math.min(Math.round(0.003 * o.outSr), N >> 2);
    const fout = Math.min(Math.round(0.06 * o.outSr), N >> 1);
    for (let i = 0; i < fin; i++) out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fin);
    for (let i = 0; i < fout; i++) out[N - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fout);
    return out;
  }

  function pickSource(sources, midi, mode) {
    let pool = sources;
    if (mode === 'best') {
      let b = sources[0];
      for (const s of sources) if (s.scoreNorm > b.scoreNorm) b = s;
      return b;
    }
    let best = null, bc = Infinity;
    for (const s of pool) {
      const cost = Math.abs((s.anchor != null ? s.anchor : s.midi) - midi) + 0.75 * (1 - (s.scoreNorm == null ? 1 : s.scoreNorm));
      if (cost < bc) { bc = cost; best = s; }
    }
    return best;
  }


  /**
   * Partes separadas: cada áudio recebe uma nota própria, em ordem de tom.
   * Dois áudios no mesmo tom: o seguinte vai para a próxima tecla livre acima.
   */
  function planParts(srcs) {
    const sorted = srcs.slice().sort((a, b) => a.midi - b.midi);
    const used = new Set();
    for (const s of sorted) {
      let m = Math.max(0, Math.min(127, Math.round(s.midi)));
      while (used.has(m) && m < 127) m++;
      while (used.has(m) && m > 0) m--;
      s.anchor = m;
      used.add(m);
    }
    return sorted;
  }

  /** Gera todas as notas de lo..hi (inclusive). */
  async function generateAll(sources, lo, hi, o, onProgress) {
    o = Object.assign({ outSr: 44100, noteLen: 1.0, mode: 'nearest', normalize: true, flOctave: true }, o || {});
    if (!sources.length) throw new Error('Nenhuma parte de voz selecionada.');
    const notes = [];
    for (let m = lo; m <= hi; m++) {
      const src = pickSource(sources, m, o.mode);
      const samples = makeNote(src, m, o);
      notes.push({ midi: m, name: noteName(m, o.flOctave), samples, srcId: src.id, shift: m - src.midi });
      if (onProgress) onProgress((m - lo + 1) / (hi - lo + 1));
      await tick();
    }
    if (o.normalize) normalizeNotes(notes);
    return notes;
  }

  function rms(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); }

  function normalizeNotes(notes) {
    const r = notes.map((n) => rms(n.samples));
    const target = median(r.filter((v) => v > 1e-6)) || 0.1;
    let globalPeak = 0;
    const gains = notes.map((n, i) => {
      let g = r[i] > 1e-6 ? target / r[i] : 1;
      g = Math.max(0.25, Math.min(4, g)); // limita a ±12 dB
      let pk = 0;
      for (let k = 0; k < n.samples.length; k++) pk = Math.max(pk, Math.abs(n.samples[k]));
      globalPeak = Math.max(globalPeak, pk * g);
      return g;
    });
    const master = globalPeak > 0 ? 0.92 / globalPeak : 1;
    notes.forEach((n, i) => {
      const g = gains[i] * master;
      for (let k = 0; k < n.samples.length; k++) n.samples[k] *= g;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Exportação: WAV (com smpl/cue), ZIP, SFZ                            */
  /* ------------------------------------------------------------------ */
  function encodeWav(samples, sr, bits, opts) {
    opts = opts || {};
    const bytes = bits / 8;
    const dataLen = samples.length * bytes;
    const chunks = [];
    if (opts.rootNote != null) {
      const b = new DataView(new ArrayBuffer(8 + 36));
      b.setUint32(0, 0x6c706d73, true); // 'smpl'
      b.setUint32(4, 36, true);
      b.setUint32(16, Math.round(1e9 / sr), true);
      b.setUint32(20, opts.rootNote, true);
      chunks.push(new Uint8Array(b.buffer));
    }
    if (opts.cues && opts.cues.length) {
      const n = opts.cues.length;
      const cue = new DataView(new ArrayBuffer(8 + 4 + 24 * n));
      cue.setUint32(0, 0x20657563, true); // 'cue '
      cue.setUint32(4, 4 + 24 * n, true);
      cue.setUint32(8, n, true);
      opts.cues.forEach((c, i) => {
        const o = 12 + 24 * i;
        cue.setUint32(o, i + 1, true);
        cue.setUint32(o + 4, c.pos, true);
        cue.setUint32(o + 8, 0x61746164, true); // 'data'
        cue.setUint32(o + 12, 0, true);
        cue.setUint32(o + 16, 0, true);
        cue.setUint32(o + 20, c.pos, true);
      });
      chunks.push(new Uint8Array(cue.buffer));
      const enc = new TextEncoder();
      const labls = opts.cues.map((c, i) => {
        const t = enc.encode(c.label);
        const len = 4 + t.length + 1;
        const padded = len + (len % 2);
        const u = new Uint8Array(8 + padded);
        const dv = new DataView(u.buffer);
        dv.setUint32(0, 0x6c62616c, true); // 'labl'
        dv.setUint32(4, len, true);
        dv.setUint32(8, i + 1, true);
        u.set(t, 12);
        return u;
      });
      const listLen = 4 + labls.reduce((p, q) => p + q.length, 0);
      const head = new DataView(new ArrayBuffer(12));
      head.setUint32(0, 0x5453494c, true); // 'LIST'
      head.setUint32(4, listLen, true);
      head.setUint32(8, 0x6c746461, true); // 'adtl'
      chunks.push(new Uint8Array(head.buffer), ...labls);
    }
    const extra = chunks.reduce((p, q) => p + q.length, 0);
    const total = 12 + 24 + 8 + dataLen + (dataLen % 2) + extra;
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    dv.setUint32(0, 0x46464952, true); // 'RIFF'
    dv.setUint32(4, total - 8, true);
    dv.setUint32(8, 0x45564157, true); // 'WAVE'
    dv.setUint32(12, 0x20746d66, true); // 'fmt '
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * bytes, true);
    dv.setUint16(32, bytes, true);
    dv.setUint16(34, bits, true);
    dv.setUint32(36, 0x61746164, true); // 'data'
    dv.setUint32(40, dataLen, true);
    let p = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      if (bits === 16) {
        dv.setInt16(p, Math.round(s < 0 ? s * 32768 : s * 32767), true);
        p += 2;
      } else {
        const v = Math.round(s < 0 ? s * 8388608 : s * 8388607);
        dv.setUint8(p, v & 255);
        dv.setUint8(p + 1, (v >> 8) & 255);
        dv.setUint8(p + 2, (v >> 16) & 255);
        p += 3;
      }
    }
    p = 44 + dataLen + (dataLen % 2);
    for (const c of chunks) { u8.set(c, p); p += c.length; }
    return u8;
  }

  function buildScaleWav(notes, o) {
    const gap = Math.round((o.gap || 0) * o.outSr);
    const len = notes[0].samples.length;
    const slot = len + gap;
    const all = new Float32Array(slot * notes.length);
    const cues = [];
    notes.forEach((n, i) => {
      all.set(n.samples, i * slot);
      cues.push({ pos: i * slot, label: n.name });
    });
    return encodeWav(all, o.outSr, o.bits, { cues, rootNote: notes[0].midi });
  }

  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** ZIP sem compressão. files: [{name, data(Uint8Array)}] */
  function buildZip(files) {
    const enc = new TextEncoder();
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, f.data.length, true);
      lh.setUint32(22, f.data.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, f.data.length, true);
      ch.setUint32(24, f.data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + f.data.length;
    }
    const cdSize = central.reduce((p, q) => p + q.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(offset + cdSize + 22);
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  /** SFZ: o DirectWave (FL Studio) e vários samplers importam este formato. */
  function buildSfz(notes, folder) {
    let s = '// FNF Chromatic Scale Generator — mapeamento por tecla\n<group>\nloop_mode=one_shot\n\n';
    for (const n of notes) {
      s += `<region> sample=${folder}${n.file || n.name + '.wav'} key=${n.midi} lokey=${n.midi} hikey=${n.midi} pitch_keycenter=${n.midi}\n`;
    }
    return s;
  }

  return {
    NOTE_NAMES, midiToFreq, freqToMidi, noteName, yin, refineF0, analyzeTrack, findSegments,
    resample, extendLoop, makeNote, psolaNote, prepareSource, planParts, pickSource, generateAll, normalizeNotes,
    encodeWav, buildScaleWav, buildZip, buildSfz, crc32, rms, median,
  };
});
