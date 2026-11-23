/*
 * Codificador FLAC (sem perdas) mínimo: mono/estéreo intercalado não suportado — só mono.
 * Usa subframes CONSTANT, FIXED (ordens 0–4, resíduo Rice com partições) e VERBATIM.
 * Sem MD5 (campo zerado = "não calculado", permitido pela especificação).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChromaFLAC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    CRC8[i] = c;
    let d = i << 8;
    for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
    CRC16[i] = d;
  }
  function crc8(b) { let c = 0; for (let i = 0; i < b.length; i++) c = CRC8[c ^ b[i]]; return c; }
  function crc16(b) { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) & 0xffff) ^ CRC16[((c >> 8) ^ b[i]) & 0xff]; return c; }

  class Bits {
    constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
    write(v, bits) {
      while (bits > 0) {
        const take = Math.min(bits, 8 - this.n), shift = bits - take, pow = Math.pow(2, shift);
        const chunk = Math.floor(v / pow);
        v -= chunk * pow;
        this.cur = (this.cur << take) | chunk;
        this.n += take; bits -= take;
        if (this.n === 8) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.n = 0; }
      }
    }
    signed(v, bits) { this.write(v < 0 ? v + Math.pow(2, bits) : v, bits); }
    unary0(q) { // q zeros seguidos de um 1
      while (q >= 8) { this.write(0, 8); q -= 8; }
      this.write(1, q + 1);
    }
    align() { if (this.n) this.write(0, 8 - this.n); }
  }

  function fixedResidual(x, order) {
    const n = x.length, r = new Int32Array(n - order);
    for (let i = order; i < n; i++) {
      let e;
      switch (order) {
        case 0: e = x[i]; break;
        case 1: e = x[i] - x[i - 1]; break;
        case 2: e = x[i] - 2 * x[i - 1] + x[i - 2]; break;
        case 3: e = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
        default: e = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
      }
      r[i - order] = e;
    }
    return r;
  }
  const zig = (r) => (r << 1) ^ (r >> 31);

  // melhor parâmetro Rice para u[a..b): retorna {k, bits}
  function bestRice(u, a, b) {
    let sum = 0;
    for (let i = a; i < b; i++) sum += u[i];
    const cnt = b - a;
    if (!cnt) return { k: 0, bits: 0 };
    const k0 = Math.max(0, Math.min(14, Math.floor(Math.log2(sum / cnt + 1))));
    let best = null;
    for (let k = Math.max(0, k0 - 1); k <= Math.min(14, k0 + 1); k++) {
      let bits = cnt * (k + 1);
      for (let i = a; i < b; i++) bits += Math.floor(u[i] / Math.pow(2, k));
      if (!best || bits < best.bits) best = { k, bits };
    }
    return best;
  }

  function planRice(res, blocksize, order) {
    const u = new Float64Array(res.length);
    for (let i = 0; i < res.length; i++) u[i] = zig(res[i]) >>> 0;
    let best = null;
    for (let p = 0; p <= 8; p++) {
      const parts = 1 << p;
      if (blocksize % parts) break;
      const sz = blocksize >> p;
      if (sz <= order) break;
      let bits = 6, ks = [], pos = 0, ok = true;
      for (let q = 0; q < parts; q++) {
        const len = q === 0 ? sz - order : sz;
        const r = bestRice(u, pos, pos + len);
        bits += 4 + r.bits;
        ks.push(r.k); pos += len;
      }
      if (ok && (!best || bits < best.bits)) best = { p, ks, bits, u };
    }
    return best;
  }

  function writeSubframe(bw, x, bps) {
    const n = x.length;
    let same = true;
    for (let i = 1; i < n; i++) if (x[i] !== x[0]) { same = false; break; }
    if (same) { bw.write(0x00, 8); bw.signed(x[0], bps); return; }
    let best = { kind: 'verbatim', bits: bps * n };
    const maxOrder = Math.min(4, n - 1);
    for (let order = 0; order <= maxOrder; order++) {
      const res = fixedResidual(x, order);
      const plan = planRice(res, n, order);
      if (!plan) continue;
      const bits = order * bps + plan.bits;
      if (bits < best.bits) best = { kind: 'fixed', order, res, plan, bits };
    }
    if (best.kind === 'verbatim') {
      bw.write(0x02, 8);
      for (let i = 0; i < n; i++) bw.signed(x[i], bps);
      return;
    }
    const { order, res, plan } = best;
    bw.write((8 + order) << 1, 8);
    for (let i = 0; i < order; i++) bw.signed(x[i], bps);
    bw.write(0, 2); // método Rice de 4 bits
    bw.write(plan.p, 4);
    const parts = 1 << plan.p, sz = n >> plan.p;
    let pos = 0;
    for (let q = 0; q < parts; q++) {
      const len = q === 0 ? sz - order : sz, k = plan.ks[q];
      bw.write(k, 4);
      for (let i = 0; i < len; i++) {
        const u = plan.u[pos + i];
        bw.unary0(Math.floor(u / Math.pow(2, k)));
        if (k) bw.write(u % Math.pow(2, k), k);
      }
      pos += len;
    }
  }

  function utf8Number(v) {
    if (v < 0x80) return [v];
    const out = [];
    let nb = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
    for (let i = nb - 1; i > 0; i--) { out.unshift(0x80 | (v & 0x3f)); v = Math.floor(v / 64); }
    out.unshift((0xff00 >> nb) & 0xff | v);
    return out;
  }

  /** samples: Int16Array/Int32Array (mono). bps: 8, 16 ou 24. Retorna Uint8Array. */
  function encodeFlac(samples, sampleRate, bps) {
    bps = bps || 16;
    const BS = 4096, total = samples.length;
    const sizeCode = { 8: 1, 16: 4, 24: 6 }[bps];
    const rateCode = { 44100: 9, 48000: 10 }[sampleRate] || 0;
    const frames = [];
    let minFs = Infinity, maxFs = 0, minBs = Infinity, maxBs = 0;
    for (let start = 0, fn = 0; start < total; start += BS, fn++) {
      const x = samples.subarray(start, Math.min(total, start + BS)), n = x.length;
      const blockCode = n === BS ? 12 : n <= 256 ? 6 : 7;
      const h = [0xff, 0xf8, (blockCode << 4) | rateCode, (0 << 4) | (sizeCode << 1)];
      h.push(...utf8Number(fn));
      if (blockCode === 6) h.push(n - 1);
      else if (blockCode === 7) h.push((n - 1) >> 8, (n - 1) & 0xff);
      if (rateCode === 0) { /* taxa vem do STREAMINFO */ }
      h.push(crc8(h));
      const bw = new Bits();
      writeSubframe(bw, x, bps);
      bw.align();
      const frame = new Uint8Array(h.length + bw.bytes.length + 2);
      frame.set(h, 0);
      frame.set(bw.bytes, h.length);
      const c = crc16(frame.subarray(0, frame.length - 2));
      frame[frame.length - 2] = c >> 8; frame[frame.length - 1] = c & 0xff;
      frames.push(frame);
      minFs = Math.min(minFs, frame.length); maxFs = Math.max(maxFs, frame.length);
      minBs = Math.min(minBs, n); maxBs = Math.max(maxBs, n);
    }
    const si = new Uint8Array(34);
    const dv = new DataView(si.buffer);
    dv.setUint16(0, Math.min(minBs, BS)); dv.setUint16(2, maxBs);
    si[4] = (minFs >> 16) & 255; si[5] = (minFs >> 8) & 255; si[6] = minFs & 255;
    si[7] = (maxFs >> 16) & 255; si[8] = (maxFs >> 8) & 255; si[9] = maxFs & 255;
    const packed = (BigInt(sampleRate) << 44n) | (0n << 41n) | (BigInt(bps - 1) << 36n) | BigInt(total);
    dv.setBigUint64(10, packed);
    // MD5 (bytes 18–33) fica zerado
    const size = 4 + 4 + 34 + frames.reduce((p, q) => p + q.length, 0);
    const out = new Uint8Array(size);
    out.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22], 0);
    out.set(si, 8);
    let p = 42;
    for (const f of frames) { out.set(f, p); p += f.length; }
    return out;
  }

  return { encodeFlac, crc8, crc16 };
});
