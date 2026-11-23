/*
 * Exportação para DirectWave (.dwp monolítico) — FL Studio Mobile e FL Studio (DirectWave).
 *
 * Este arquivo é um port para JavaScript da lógica de escrita do DirectWave do projeto
 * ConvertWithMoss, de Jürgen Moßgraber (https://github.com/git-moss/ConvertWithMoss),
 * licenciado sob a LGPL v3 (http://www.gnu.org/licenses/lgpl-3.0.txt). Os blocos-modelo abaixo
 * foram extraídos de uma exportação real do DirectWave e copiados de lá. Este arquivo,
 * por ser obra derivada, também é distribuído sob a LGPL v3.
 *
 * Estrutura: preâmbulo fixo (0x5A bytes) + fluxo de blocos [tag u32][tamanho u32][0 u32][dados].
 * Cada zona (tecla) é um bloco 0x0003 que contém seus próprios blocos, com o áudio em FLAC (0x0206).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./flac.js'));
  else root.ChromaDWP = factory(root.ChromaFLAC);
})(typeof self !== 'undefined' ? self : this, function (FLAC) {
  'use strict';

  const hex = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const T = {
    PREAMBLE: hex("447750722600000006000000100000000000000023000000000000000000000000000000010000000000000000000000640000001e000000000000000000000000000000803f0000000000000000000000000000000000000000"),
    PROGRAM_1: hex("00000000403f0000403f0000003f0000403f"),
    PROGRAM_2: hex("000000803e0000003f0000403f0000803e"),
    PROGRAM_3: hex("000000803e0000003f0000803e00000000"),
    PROGRAM_4: hex("00000000cdcccc3d0000803f0000000000000000"),
    CONTAINER: hex("f40100001900000000000000190c1a007f000000000000803f0000003f0000000000020000f50100000e000000000000004c656164202d20416c6f6e652030f60100002400000000000000473a5c355c4c656164202d20416c6f6e655c4c656164202d20416c6f6e6520302e776176f70100002800000000000000006c050000000000020000004000000000442c4702000000a3100400486b05000000000020000000f801000008000000000000000000003f00006400f90100000e000000000000000000000000000000000000000000fa01000030000000000000000000000000000000000000000000803f0000000000000000000000000000000000000000000000000000000000000000fb01000014000000000000000000000050237e3f000000000000000000000000fb01000014000000000000000000000000000000000000000000000000000000fc01000002000000000000000000fd0100001000000000000000c976be3dae47a13ef8fb7d3f295c0f3ffe0100000900000000000000000000000000000000ff01000009000000000000000000000000000000000002000009000000000000000000000000000000000102000009000000000000000000000000000000000202000010000000000000000000000000000000f8fb7d3f6f15d53e0202000010000000000000000000000000000000f8fb7d3f6f15d53e030200001400000000000000020000006e12833a000000000000000000000000030200001400000000000000020000006e12833a000000000000000000000000040200000800000000000000020002000000003f040200000800000000000000040001002549123f04020000080000000000000000000000000000000402000008000000000000000000000000000000040200000800000000000000000000000000000004020000080000000000000000000000000000000402000008000000000000000000000000000000040200000800000000000000000000000000000004020000080000000000000000000000000000000402000008000000000000000000000000000000040200000800000000000000000000000000000004020000080000000000000000000000000000000402000008000000000000000000000000000000040200000800000000000000000000000000000004020000080000000000000000000000000000000402000008000000000000000000000000000000040000000000000000000000"),
  };

  const TAG = {
    INSTRUMENT_NAME: 0x66, INSTRUMENT_PATH: 0x67, SHADOW_NAME: 0x68, SHADOW_PATH: 0x69,
    METADATA_1: 0x6a, METADATA_2: 0x6b, METADATA_3: 0x6c, METADATA_4: 0x6d, PARAMETER_SLOT: 0x6e,
    SAMPLE_CONTAINER: 0x03, TERMINATOR: 0x02, SAMPLE_TERMINATOR: 0x04,
    ZONE_MAPPING: 0x1f4, SAMPLE_NAME: 0x1f5, SAMPLE_PATH: 0x1f6, AUDIO_FORMAT: 0x1f7, AMP_ENVELOPE: 0x1fd,
    EMBEDDED_AUDIO: 0x206,
  };
  const NUM_PARAMETER_SLOTS = 100, PREAMBLE_SIZE_OFFSET = 0x28, PREAMBLE_SIZE_DELTA = 48, PREAMBLE_COUNT_OFFSET = 0x4a;
  const SHADOW_NAME_LENGTH = 10, EMBEDDED_AUDIO_BLOCK = 512, EMBEDDED_AUDIO_OFFSET = 8;

  const latin1 = (s) => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255; return o; };
  const u32 = (dv, off, v) => dv.setUint32(off, v >>> 0, true);

  function chunk(tag, payload) {
    if (typeof payload === 'string') payload = latin1(payload);
    const o = new Uint8Array(12 + payload.length);
    const dv = new DataView(o.buffer);
    u32(dv, 0, tag); u32(dv, 4, payload.length); u32(dv, 8, 0);
    o.set(payload, 12);
    return o;
  }
  function concat(list) {
    const n = list.reduce((p, q) => p + q.length, 0), o = new Uint8Array(n);
    let p = 0;
    for (const a of list) { o.set(a, p); p += a.length; }
    return o;
  }
  function parseChunks(data) {
    const out = [], dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let i = 0;
    while (i + 12 <= data.length) {
      const tag = dv.getUint32(i, true), len = dv.getUint32(i + 4, true);
      out.push({ tag, payload: data.slice(i + 12, i + 12 + len) });
      i += 12 + len;
    }
    return out;
  }

  /** Remove acentos/símbolos: nomes de amostra seguros para o DirectWave. */
  const safe = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_#\-]/g, '_');

  function toInt16(f) {
    const o = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]));
      o[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
    }
    return o;
  }

  /** Um bloco-container (uma tecla). note: {midi, name, samples(Float32Array)} */
  function sampleContainer(instrument, note, sampleRate) {
    const sampleName = instrument + '_' + safe(note.name) + '_127';
    const pcm = toInt16(note.samples);
    const frames = Math.ceil(pcm.length / EMBEDDED_AUDIO_BLOCK) * EMBEDDED_AUDIO_BLOCK;
    const guard = EMBEDDED_AUDIO_BLOCK / 2;
    const padded = new Int16Array(guard + frames + guard);
    padded.set(pcm, guard);
    const flac = FLAC.encodeFlac(padded, sampleRate, 16);
    const emb = new Uint8Array(EMBEDDED_AUDIO_OFFSET + flac.length);
    new DataView(emb.buffer).setUint32(0, flac.length, true);
    emb.set(flac, EMBEDDED_AUDIO_OFFSET);

    const out = [];
    for (const c of parseChunks(T.CONTAINER)) {
      let p = c.payload;
      switch (c.tag) {
        case TAG.ZONE_MAPPING: {
          p = p.slice();
          p[0] = note.midi; p[1] = note.midi; p[2] = note.midi; // raiz, tecla baixa, tecla alta
          p[3] = 0; p[4] = 127;                                 // velocidade 0–127
          out.push(chunk(c.tag, p));
          break;
        }
        case TAG.SAMPLE_NAME: out.push(chunk(c.tag, sampleName)); break;
        case TAG.SAMPLE_PATH: out.push(chunk(c.tag, 'D:\\' + instrument + '\\' + sampleName + '.wav')); break;
        case TAG.AUDIO_FORMAT: {
          p = p.slice();
          const dv = new DataView(p.buffer);
          u32(dv, 0, frames);                       // quantidade de frames
          u32(dv, 8, 1);                            // canais (mono)
          const blocks = Math.ceil(frames / 8192);
          let stride = 1; while (stride < blocks) stride <<= 1;
          u32(dv, 12, Math.max(4, stride));
          dv.setFloat32(16, sampleRate, true);      // taxa de amostragem (float)
          u32(dv, 20, 0);                           // loop desligado
          u32(dv, 24, 0); u32(dv, 28, 0);
          out.push(chunk(c.tag, p));
          break;
        }
        case TAG.AMP_ENVELOPE: {
          p = p.slice();
          const dv = new DataView(p.buffer);
          [0, 0.5, 1, 0.25].forEach((v, i) => dv.setFloat32(i * 4, v, true)); // padrão do FL Mobile
          out.push(chunk(c.tag, p));
          break;
        }
        case TAG.SAMPLE_TERMINATOR:
          out.push(chunk(TAG.EMBEDDED_AUDIO, emb), chunk(c.tag, p));
          break;
        default: out.push(chunk(c.tag, p));
      }
    }
    return concat(out);
  }

  /**
   * Monta o arquivo .dwp. notes: [{midi, name, samples}], sampleRate em Hz.
   * Todas as notas viram zonas de uma única tecla cada (instrumento monolítico).
   */
  function buildDwp(name, notes, sampleRate) {
    name = safe(name || 'Chromatic');
    const parts = [
      chunk(TAG.INSTRUMENT_NAME, name),
      chunk(TAG.INSTRUMENT_PATH, 'D:\\' + name + '.dwp'),
      chunk(TAG.SHADOW_NAME, new Uint8Array(SHADOW_NAME_LENGTH)),
      chunk(TAG.SHADOW_PATH, T.PROGRAM_1),
      chunk(TAG.METADATA_1, T.PROGRAM_2),
      chunk(TAG.METADATA_2, T.PROGRAM_3),
      chunk(TAG.METADATA_3, T.PROGRAM_4),
      chunk(TAG.METADATA_3, T.PROGRAM_4),
    ];
    for (let i = 0; i < 4; i++) parts.push(chunk(TAG.METADATA_4, new Uint8Array(4)));
    for (let i = 0; i < NUM_PARAMETER_SLOTS; i++) {
      const slot = new Uint8Array(13), dv = new DataView(slot.buffer);
      dv.setUint32(0, i, true); dv.setFloat32(5, 1.0, true);
      parts.push(chunk(TAG.PARAMETER_SLOT, slot));
    }
    for (const n of notes) parts.push(chunk(TAG.SAMPLE_CONTAINER, sampleContainer(name, n, sampleRate)));
    parts.push(chunk(TAG.TERMINATOR, new Uint8Array(0)));
    const stream = concat(parts);
    const file = new Uint8Array(T.PREAMBLE.length + stream.length);
    file.set(T.PREAMBLE, 0);
    file.set(stream, T.PREAMBLE.length);
    const dv = new DataView(file.buffer);
    u32(dv, PREAMBLE_SIZE_OFFSET, file.length - PREAMBLE_SIZE_DELTA);
    u32(dv, PREAMBLE_COUNT_OFFSET, notes.length);
    return file;
  }

  return { buildDwp, parseChunks, safe, PREAMBLE_SIZE: T.PREAMBLE.length, TAG };
});
