// Teste de precisão do núcleo DSP. Rode com: node tests/dsp.test.js
const D = require('../js/dsp.js');
const SR = 44100;

// "Voz" sintética: tom harmônico com vibrato leve e envelope, vogal com formantes simples.
function voice(f0, dur, vib) {
  const n = Math.round(dur * SR), x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * (1 + (vib || 0) * Math.sin(2 * Math.PI * 5 * t));
    ph += (2 * Math.PI * f) / SR;
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(h * ph) / h;
    const env = Math.min(1, t / 0.03) * Math.min(1, (dur - t) / 0.05);
    x[i] = 0.3 * s * env;
  }
  return x;
}

(async () => {
  let fail = 0;
  const check = (name, ok, info) => { console.log((ok ? 'OK   ' : 'FALHA') + ' ' + name + (info ? ' — ' + info : '')); if (!ok) fail++; };

  // 1) YIN
  for (const f of [110, 196, 261.63, 440, 700]) {
    const x = voice(f, 0.5);
    const r = D.yin(x, 4000, 1400, SR, 65, 900, 0.15);
    const cents = 1200 * Math.log2(r.f0 / f);
    check('YIN ' + f + ' Hz', Math.abs(cents) < 3, cents.toFixed(2) + ' cents');
  }

  // 2) Auto-corte numa "fala": silêncio + 3 sílabas com pitches diferentes + ruído
  const parts = [[0, 0.2], [180, 0.35], [0, 0.1], [233, 0.4], [0, 0.15], [150, 0.3], [0, 0.2]];
  let total = parts.reduce((p, q) => p + q[1], 0);
  const sp = new Float32Array(Math.round(total * SR));
  let off = 0;
  for (const [f, d] of parts) {
    const n = Math.round(d * SR);
    if (f) sp.set(voice(f, d, 0.004), off);
    off += n;
  }
  for (let i = 0; i < sp.length; i++) sp[i] += (Math.random() - 0.5) * 0.004;
  const tr = await D.analyzeTrack(sp, SR);
  const segs = D.findSegments(sp, SR, tr);
  check('Auto-corte acha 3 trechos', segs.length === 3, segs.length + ' trechos');
  const expect = [180, 233, 150];
  for (const e of expect) {
    const s = segs.find((q) => Math.abs(1200 * Math.log2(q.f0 / e)) < 25);
    const c = s ? 1200 * Math.log2(s.f0 / e) : NaN;
    check('Trecho ' + e + ' Hz detectado', !!s && Math.abs(c) < 6, s ? c.toFixed(2) + ' cents' : 'não achou');
  }

  // 3) Geração: cada tecla de C2 a C7 deve cair a < 5 cents do alvo
  // fonte estável (sem vibrato) passando pelo mesmo Auto-Corte, para medir só a afinação da geração
  const steady = new Float32Array(Math.round(0.8 * SR));
  steady.set(voice(205, 0.8, 0), 0);
  const trS = await D.analyzeTrack(steady, SR);
  const segS = D.findSegments(steady, SR, trS);
  check('Auto-corte na fonte estável', segS.length >= 1 && Math.abs(1200 * Math.log2(segS[0].f0 / 205)) < 2, segS.length ? (1200 * Math.log2(segS[0].f0 / 205)).toFixed(2) + ' cents' : 'nada');
  const best = segS[0];
  const src = { data: steady, a: best.a, b: best.b, f0: best.f0, sr: SR, id: 0, midi: best.midi, scoreNorm: 1 };
  const notes = await D.generateAll([src], 36, 96, { outSr: SR, noteLen: 1.0 });
  check('Gerou 61 notas (C2–C7)', notes.length === 61, String(notes.length));
  let worst = 0, worstM = 0;
  for (const n of notes) {
    const f = D.midiToFreq(n.midi);
    // mede o pitch por autocorrelação em lag longo (K ciclos) + interpolação parabólica
    const y = n.samples, a = Math.round(0.15 * SR), W = Math.round(0.3 * SR);
    const P = SR / f, K = Math.max(1, Math.floor(0.25 * SR / P));
    const corr = (lag) => { let s = 0; for (let i = 0; i < W; i++) s += y[a + i] * y[a + i + lag]; return s; };
    const c0 = Math.round(K * P); let bl = c0, bv = -Infinity;
    for (let l = c0 - Math.ceil(P / 2); l <= c0 + Math.ceil(P / 2); l++) { const v = corr(l); if (v > bv) { bv = v; bl = l; } }
    const ca = corr(bl - 1), cb = corr(bl), cc = corr(bl + 1), den = ca - 2 * cb + cc;
    const lagF = bl + (Math.abs(den) > 1e-12 ? 0.5 * (ca - cc) / den : 0);
    const r = { f0: K * SR / lagF };
    const c = r.f0 > 0 ? Math.abs(1200 * Math.log2(r.f0 / f)) : 999;
    if (c > worst) { worst = c; worstM = n.midi; }
  }
  check('Afinação de todas as teclas', worst < 3, 'pior erro ' + worst.toFixed(2) + ' cents (MIDI ' + worstM + ')');

  // 4) Extensão com loop não deve ter cliques
  let maxJump = 0;
  const nn = notes.find((n) => n.midi === 60).samples;
  for (let i = 1; i < nn.length; i++) maxJump = Math.max(maxJump, Math.abs(nn[i] - nn[i - 1]));
  check('Sem cliques no loop (C5)', maxJump < 0.35, 'maior salto ' + maxJump.toFixed(3));
  check('Sem clipping', notes.every((n) => n.samples.every((v) => Math.abs(v) <= 1)));

  // 5) WAV e ZIP
  const wav = D.buildScaleWav(notes.slice(0, 3), { outSr: SR, bits: 16, gap: 0 });
  check('WAV começa com RIFF/WAVE', String.fromCharCode(...wav.slice(0, 4)) === 'RIFF' && String.fromCharCode(...wav.slice(8, 12)) === 'WAVE');
  const zip = D.buildZip([{ name: 'a.txt', data: new TextEncoder().encode('oi') }, { name: 'b.wav', data: wav }]);
  require('fs').writeFileSync('/tmp/_t.zip', zip);
  require('fs').writeFileSync('/tmp/_t.wav', wav);
  require('fs').writeFileSync('/tmp/_t24.wav', D.encodeWav(notes[24].samples, SR, 24, { rootNote: 60 }));

  console.log(fail ? '\n' + fail + ' falha(s)' : '\nTudo certo');
  process.exit(fail ? 1 : 0);
})();
