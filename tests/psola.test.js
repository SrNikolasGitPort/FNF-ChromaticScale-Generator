// Testes do PSOLA: afinação em todas as teclas, preservação de formantes e tempo.
// Rode com: node tests/psola.test.js
const D = require('../js/dsp.js');
const SR = 44100;
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? 'OK   ' : 'FALHA') + ' ' + name + (info ? ' — ' + info : '')); if (!ok) fail++; };

// Vogal com formantes fixos (F1=700 Hz, F2=1200 Hz): amplitude de cada harmônico segue o envelope espectral.
function vowel(f0, dur) {
  const env = (f) => 1 / (1 + Math.pow((f - 700) / 130, 2)) + 0.7 / (1 + Math.pow((f - 1200) / 160, 2)) + 0.02;
  const n = Math.round(dur * SR), x = new Float32Array(n);
  for (let h = 1; h * f0 < 5000; h++) {
    const a = env(h * f0) * 0.12, w = (2 * Math.PI * h * f0) / SR;
    for (let i = 0; i < n; i++) x[i] += a * Math.sin(w * i + h);
  }
  const fade = Math.round(0.03 * SR);
  for (let i = 0; i < fade; i++) { const g = i / fade; x[i] *= g; x[n - 1 - i] *= g; }
  return x;
}

// Pitch por autocorrelação em lag longo + parabólica
function measure(y, f) {
  const a = Math.round(0.15 * SR), W = Math.round(0.3 * SR);
  const P = SR / f, K = Math.max(1, Math.floor((0.25 * SR) / P));
  const corr = (lag) => { let s = 0; for (let i = 0; i < W; i++) s += y[a + i] * y[a + i + lag]; return s; };
  const c0 = Math.round(K * P);
  let bl = c0, bv = -Infinity;
  for (let l = Math.max(1, c0 - Math.ceil(P / 2)); l <= c0 + Math.ceil(P / 2); l++) { const v = corr(l); if (v > bv) { bv = v; bl = l; } }
  const ca = corr(bl - 1), cb = corr(bl), cc = corr(bl + 1), den = ca - 2 * cb + cc;
  return (K * SR) / (bl + (Math.abs(den) > 1e-12 ? (0.5 * (ca - cc)) / den : 0));
}

// amplitude do harmônico h de f (projeção sobre seno/cosseno em janela inteira de ciclos)
function harmonicAmp(y, f, h) {
  const w = (2 * Math.PI * h * f) / SR, a = Math.round(0.2 * SR), n = Math.round(0.4 * SR);
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) { re += y[a + i] * Math.cos(w * i); im += y[a + i] * Math.sin(w * i); }
  return Math.hypot(re, im) / n;
}
function spectralCentroid(y, f) {
  let num = 0, den = 0;
  for (let h = 1; h * f < 3000; h++) { const A = harmonicAmp(y, f, h); num += A * h * f; den += A; }
  return num / den;
}

(async () => {
  const x = vowel(200, 0.6);
  const tr = await D.analyzeTrack(x, SR);
  const segs = D.findSegments(x, SR, tr);
  check('Fonte estável detectada', segs.length >= 1 && Math.abs(1200 * Math.log2(segs[0].f0 / 200)) < 2);
  const b = segs[0];
  const mk = () => ({ data: x, a: b.a, b: b.b, f0: b.f0, sr: SR, id: 0, midi: b.midi, scoreNorm: 1 });

  // 1) Afinação em todas as 120 teclas (C0..B9)
  const t0 = Date.now();
  const notes = await D.generateAll([mk()], 0, 119, { outSr: SR, noteLen: 1.0, normalize: true });
  const secs = (Date.now() - t0) / 1000;
  let worst = 0, wm = 0, sum = 0;
  for (const n of notes) {
    const f = D.midiToFreq(n.midi);
    const c = Math.abs(1200 * Math.log2(measure(n.samples, f) / f));
    sum += c; if (c > worst) { worst = c; wm = n.midi; }
  }
  check('Afinação das 120 teclas', worst < 3, 'pior ' + worst.toFixed(2) + ' cents (MIDI ' + wm + '), média ' + (sum / 120).toFixed(2));
  check('Tempo de geração das 120 teclas', secs < 90, secs.toFixed(1) + ' s');
  check('Sem clipping nem NaN', notes.every((n) => n.samples.every((v) => Math.abs(v) <= 1 && v === v)));

  // 2) Formantes: voz de 200 Hz com F1=700 Hz levada a 300 Hz.
  //    PSOLA mantém o centroide espectral perto do original; reamostragem puro o desloca ×1,5.
  const f = 300;
  const o = { outSr: SR, noteLen: 1.0 };
  const ps = D.makeNote(mk(), D.freqToMidi(f), Object.assign({ psola: true }, o));
  const rs = D.makeNote(mk(), D.freqToMidi(f), Object.assign({ psola: false }, o));
  // referência: a mesma vogal sintetizada de verdade em 300 Hz
  const ref = vowel(f, 1.0);
  const cRef = spectralCentroid(ref, f), cPs = spectralCentroid(ps, f), cRs = spectralCentroid(rs, f);
  check('PSOLA preserva formantes', Math.abs(cPs / cRef - 1) < 0.12, 'centroide ref ' + cRef.toFixed(0) + ' Hz, PSOLA ' + cPs.toFixed(0) + ' Hz');
  check('Reamostragem pura desloca formantes (controle do teste)', Math.abs(cRs / cRef - 1) > 0.2, 'reamostragem ' + cRs.toFixed(0) + ' Hz');

  // 3) Sem cliques na extensão: maior salto entre amostras adjacentes numa nota média
  const mid = notes.find((n) => n.midi === 60).samples;
  let rmsv = 0; for (const v of mid) rmsv += v * v; rmsv = Math.sqrt(rmsv / mid.length);
  let jump = 0; for (let i = 1; i < mid.length; i++) jump = Math.max(jump, Math.abs(mid[i] - mid[i - 1]));
  check('Sem cliques (C5)', jump < rmsv * 6, 'salto ' + jump.toFixed(3) + ' vs RMS ' + rmsv.toFixed(3));

  // 4) Partes separadas: ordem e uso de todos os áudios
  const parts = [{ midi: 55.2, id: 1 }, { midi: 48.1, id: 2 }, { midi: 48.3, id: 3 }, { midi: 62, id: 4 }];
  const plan = D.planParts(parts);
  check('planParts ordena e não repete notas', plan.map((p) => p.anchor).join() === '48,49,55,62', plan.map((p) => p.anchor).join());

  console.log(fail ? '\n' + fail + ' falha(s)' : '\nTudo certo');
  process.exit(fail ? 1 : 0);
})();
