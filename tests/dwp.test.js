// Teste do exportador DWP: parser independente + decodificação do FLAC embutido com o ffmpeg.
// Rode com: node tests/dwp.test.js   (precisa do ffmpeg no PATH)
const W = require('../js/dwp.js');
const D = require('../js/dsp.js');
const fs = require('fs');
const { execFileSync } = require('child_process');
const SR = 44100;
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? 'OK   ' : 'FALHA') + ' ' + name + (info ? ' — ' + info : '')); if (!ok) fail++; };

// notas sintéticas em algumas teclas, comprimentos que NÃO são múltiplos de 512
const keys = [0, 12, 60, 61, 119];
const notes = keys.map((m, i) => {
  const f = D.midiToFreq(m), n = 30000 + i * 777, s = new Float32Array(n);
  for (let k = 0; k < n; k++) s[k] = 0.5 * Math.sin((2 * Math.PI * f * k) / SR) * Math.min(1, k / 200, (n - k) / 200);
  return { midi: m, name: D.noteName(m, true), samples: s };
});
const dwp = W.buildDwp('Chromatic Voz', notes, SR);
const dv = new DataView(dwp.buffer);

check('Assinatura "DwPr"', String.fromCharCode(...dwp.slice(0, 4)) === 'DwPr');
check('Versão 0x26 no preâmbulo', dwp[4] === 0x26);
check('Campo de tamanho = arquivo − 48', dv.getUint32(0x28, true) === dwp.length - 48, dv.getUint32(0x28, true) + ' vs ' + (dwp.length - 48));
check('Contagem de amostras no preâmbulo', dv.getUint32(0x4a, true) === notes.length);

// percorre o fluxo de blocos de cima a baixo — tem que terminar exatamente no fim do arquivo
const top = W.parseChunks(dwp.subarray(W.PREAMBLE_SIZE));
const consumed = top.reduce((p, c) => p + 12 + c.payload.length, 0);
check('Fluxo de blocos fecha exatamente no fim', consumed === dwp.length - W.PREAMBLE_SIZE, consumed + ' bytes');
check('Último bloco é o terminador 0x0002', top[top.length - 1].tag === 2 && top[top.length - 1].payload.length === 0);
const containers = top.filter((c) => c.tag === 3);
check('Um container por nota', containers.length === notes.length, String(containers.length));
check('100 blocos de parâmetros', top.filter((c) => c.tag === 0x6e).length === 100);
check('Nome do instrumento seguro', Buffer.from(top[0].payload).toString('latin1') === 'Chromatic_Voz', Buffer.from(top[0].payload).toString('latin1'));

// compara cada container com o modelo original (ordem das tags) e confere os campos alterados
const tpl = W.parseChunks(Buffer.from(fs.readFileSync(__dirname + '/../js/dwp.js', 'utf8').match(/CONTAINER: hex\("([0-9a-f]+)"\)/)[1], 'hex'));
containers.forEach((c, i) => {
  const ch = W.parseChunks(c.payload), tags = ch.map((x) => x.tag);
  const expect = [];
  tpl.forEach((t) => { if (t.tag === 4) expect.push(0x206); expect.push(t.tag); });
  const n = notes[i];
  check('Container ' + n.name + ': ordem dos blocos igual ao modelo', tags.join() === expect.join());
  const map = ch.find((x) => x.tag === 0x1f4).payload;
  check('  zona = tecla ' + n.midi + ' (raiz/baixa/alta, vel 0–127)', map[0] === n.midi && map[1] === n.midi && map[2] === n.midi && map[3] === 0 && map[4] === 127);
  const fmt = new DataView(ch.find((x) => x.tag === 0x1f7).payload.buffer.slice(0));
  const frames = Math.ceil(n.samples.length / 512) * 512;
  check('  frames múltiplo de 512 e canal mono', fmt.getUint32(0, true) === frames && fmt.getUint32(8, true) === 1 && fmt.getFloat32(16, true) === SR, frames + ' frames');
  // blocos que não devem mudar
  const same = [0x1f8, 0x1f9, 0x1fa, 0x1fb, 0x1fc, 0x1fe, 0x1ff, 0x200, 0x201, 0x202, 0x203, 0x204];
  const untouched = ch.filter((x) => same.includes(x.tag)).every((x, k) => Buffer.compare(Buffer.from(x.payload), Buffer.from(tpl.filter((t) => same.includes(t.tag))[k].payload)) === 0);
  check('  blocos de filtro/LFO/modulação idênticos ao modelo', untouched);
  // FLAC embutido: decodifica e compara com o PCM esperado (guarda de 256 frames dos dois lados)
  const emb = ch.find((x) => x.tag === 0x206).payload;
  const len = new DataView(emb.buffer.slice(emb.byteOffset, emb.byteOffset + 4)).getUint32(0, true);
  check('  tamanho do FLAC bate com o cabeçalho', len === emb.length - 8, len + ' bytes');
  fs.writeFileSync('/tmp/_emb.flac', emb.subarray(8));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', '/tmp/_emb.flac', '-f', 's16le', '-acodec', 'pcm_s16le', '-'], { maxBuffer: 1 << 28 });
  const got = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  let ok = got.length === 256 + frames + 256;
  for (let k = 0; ok && k < n.samples.length; k++) {
    const v = Math.max(-1, Math.min(1, n.samples[k])), e = Math.round(v < 0 ? v * 32768 : v * 32767);
    if (got[256 + k] !== e) ok = false;
  }
  for (let k = 0; ok && k < 256; k++) if (got[k] !== 0 || got[256 + frames + k] !== 0) ok = false;
  check('  áudio FLAC decodificado idêntico (com guarda de silêncio)', ok, got.length + ' amostras');
});

fs.writeFileSync('/tmp/_test.dwp', dwp);
console.log(fail ? '\n' + fail + ' falha(s)' : '\nTudo certo');
process.exit(fail ? 1 : 0);
