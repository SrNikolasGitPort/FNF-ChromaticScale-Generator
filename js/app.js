(function () {
  'use strict';
  const D = window.ChromaDSP, DWP = window.ChromaDWP;
  const $ = (id) => document.getElementById(id);

  // Tudo fixo de propósito: teclado completo do FL Studio (MIDI 0–119 = C0–B9), 44,1 kHz, 16 bits.
  const LO = 0, HI = 119, OUT_SR = 44100, NOTE_LEN = 1.5, MAX_SECONDS = 90;
  const noteName = (m) => D.noteName(m, true);
  const S = { notes: null, busy: false, ctx: null };

  const audioCtx = () => (S.ctx = S.ctx || new (window.AudioContext || window.webkitAudioContext)());
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function progress(p, text) {
    const el = $('prog');
    el.hidden = false;
    el.firstElementChild.style.width = Math.round(p * 100) + '%';
    el.lastElementChild.textContent = text;
  }
  function info(text, isError) {
    const box = $('info');
    box.innerHTML = '';
    if (!text) return;
    const d = document.createElement('div');
    d.className = isError ? 'msg' : 'ok';
    d.textContent = text;
    box.appendChild(d);
  }
  function download(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function decode(file) {
    const buf = await file.arrayBuffer();
    const ab = await new Promise((res, rej) => audioCtx().decodeAudioData(buf, res, rej));
    const n = Math.min(ab.length, Math.round(ab.sampleRate * MAX_SECONDS));
    const mono = new Float32Array(n);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const ch = ab.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += ch[i] / ab.numberOfChannels;
    }
    return { data: mono, sr: ab.sampleRate, name: file.name };
  }

  /* ---------- 1 áudio: Auto-Corte ---------- */
  async function sourcesFromSingle(file, base, span) {
    const raw = await decode(file);
    const tr = await D.analyzeTrack(raw.data, raw.sr, { onProgress: (p) => progress(base + p * span, 'Procurando as melhores partes da voz…') });
    const presets = [
      { minConf: 0.82, maxStd: 40, rmsRel: 0.08, minDur: 0.09 },
      { minConf: 0.7, maxStd: 70, rmsRel: 0.05, minDur: 0.06 },
    ];
    let segs = [];
    for (const p of presets) {
      segs = D.findSegments(raw.data, raw.sr, tr, Object.assign({ maxSegments: 14 }, p));
      if (segs.length) break;
    }
    return segs
      .filter((s, i) => i === 0 || s.scoreNorm >= 0.25)
      .map((s, i) => Object.assign(s, { id: i + 1, data: raw.data, sr: raw.sr, label: file.name }));
  }

  /* ---------- vários áudios: um por nota, em ordem ---------- */
  async function sourcesFromParts(files, base, span) {
    const out = [], skipped = [];
    for (let i = 0; i < files.length; i++) {
      progress(base + (i / files.length) * span, 'Analisando áudio ' + (i + 1) + ' de ' + files.length + '…');
      try {
        const raw = await decode(files[i]);
        const tr = await D.analyzeTrack(raw.data, raw.sr);
        const segs = D.findSegments(raw.data, raw.sr, tr, { minConf: 0.7, maxStd: 80, rmsRel: 0.05, minDur: 0.05, maxSegments: 1 });
        if (!segs.length) { skipped.push(files[i].name); continue; }
        out.push(Object.assign(segs[0], { id: i + 1, data: raw.data, sr: raw.sr, scoreNorm: 1, label: files[i].name }));
      } catch (e) { skipped.push(files[i].name); }
    }
    D.planParts(out); // cada áudio ganha sua nota, em ordem do mais grave ao mais agudo
    return { sources: out, skipped };
  }

  /* ---------- fluxo principal ---------- */
  $('files').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || S.busy) return;
    S.busy = true; S.notes = null;
    $('s-result').hidden = true;
    info('');
    try {
      let sources, skipped = [];
      progress(0, 'Abrindo áudio…');
      if (files.length === 1) {
        sources = await sourcesFromSingle(files[0], 0, 0.3);
        if (!sources.length) {
          info('Não achei trechos com tom estável. Grave vogais sustentadas ("aaaa", "oooo") com pouco ruído de fundo e tente de novo.', true);
          $('prog').hidden = true; S.busy = false; return;
        }
      } else {
        ({ sources, skipped } = await sourcesFromParts(files, 0, 0.3));
        if (!sources.length) {
          info('Nenhum dos áudios tinha um tom detectável. Use áudios com voz cantada/sustentada.', true);
          $('prog').hidden = true; S.busy = false; return;
        }
      }
      const srcs = sources.map((s) => ({ data: s.data, a: s.a, b: s.b, f0: s.f0, sr: s.sr, id: s.id, midi: s.midi, anchor: s.anchor, scoreNorm: s.scoreNorm }));
      const notes = await D.generateAll(srcs, LO, HI, { outSr: OUT_SR, noteLen: NOTE_LEN, mode: 'nearest', normalize: true, flOctave: true },
        (p) => progress(0.3 + p * 0.7, 'Montando a chromatic… ' + Math.round(p * 100) + '%'));
      S.notes = notes;
      showResult(sources, skipped, files.length > 1);
    } catch (err) {
      info('Algo deu errado: ' + (err && err.message ? err.message : err) + '. Tente WAV ou MP3.', true);
    }
    $('prog').hidden = true;
    S.busy = false;
    e.target.value = '';
  });

  function showResult(sources, skipped, parts) {
    const names = sources
      .map((s) => ({ n: noteName(Math.round(parts ? s.anchor : s.midi)), m: parts ? s.anchor : s.midi, l: s.label }))
      .sort((a, b) => a.m - b.m);
    $('stats').innerHTML =
      `<span>${S.notes.length} notas</span><span>${noteName(LO)} → ${noteName(HI)}</span>` +
      `<span>${sources.length} ${parts ? 'áudio(s) usado(s)' : 'parte(s) da voz'}</span>`;
    const detail = parts
      ? 'Notas atribuídas: ' + names.map((x) => x.n).join(', ') + '.'
      : 'Partes da voz usadas: ' + names.map((x) => x.n).join(', ') + '.';
    info(detail + (skipped.length ? ' Ignorados (sem tom): ' + skipped.join(', ') + '.' : ''), false);
    $('s-result').hidden = false;
    buildKeyboard();
    $('s-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- downloads ---------- */
  async function withBusy(btn, label, fn) {
    const old = btn.innerHTML;
    btn.disabled = true; btn.textContent = label;
    await tick(); await tick();
    try { fn(); } catch (e) { alert('Erro ao gerar o arquivo: ' + e.message); }
    btn.disabled = false; btn.innerHTML = old;
  }
  $('dl-dwp').addEventListener('click', (e) => withBusy(e.currentTarget, 'Preparando DWP…', () => {
    download(DWP.buildDwp('Chromatic_Voz', S.notes, OUT_SR), 'Chromatic_Voz.dwp', 'application/octet-stream');
  }));
  $('dl-wav').addEventListener('click', (e) => withBusy(e.currentTarget, 'Preparando WAV…', () => {
    download(D.buildScaleWav(S.notes, { outSr: OUT_SR, bits: 16, gap: 0.1 }), 'Chromatic_Voz.wav', 'audio/wav');
  }));
  $('dl-zip').addEventListener('click', (e) => withBusy(e.currentTarget, 'Preparando ZIP…', () => {
    S.notes.forEach((n) => (n.file = String(n.midi).padStart(3, '0') + '_' + n.name.replace('#', 's') + '.wav'));
    const files = S.notes.map((n) => ({ name: 'samples/' + n.file, data: D.encodeWav(n.samples, OUT_SR, 16, { rootNote: n.midi }) }));
    files.push({ name: 'chromatic.sfz', data: new TextEncoder().encode(D.buildSfz(S.notes, 'samples/')) });
    download(D.buildZip(files), 'Chromatic_Voz.zip', 'application/zip');
  }));

  /* ---------- teclado de teste ---------- */
  function buildKeyboard() {
    const kb = $('kb');
    kb.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'in';
    const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
    let wi = 0;
    const blacks = [];
    S.notes.forEach((n) => {
      const el = document.createElement('div');
      el.dataset.midi = n.midi;
      el.title = n.name;
      if (isBlack(n.midi)) { el.className = 'b'; blacks.push([el, wi]); }
      else { el.className = 'w'; el.style.left = wi * 26 + 'px'; if (n.midi % 12 === 0) el.textContent = n.name; wi++; }
      inner.appendChild(el);
    });
    blacks.forEach(([el, i]) => (el.style.left = i * 26 - 8 + 'px'));
    inner.style.width = wi * 26 + 'px';
    kb.appendChild(inner);
    kb.scrollLeft = 5 * 7 * 26 - 40; // começa perto da região central da voz
  }
  let active = null;
  function stopActive() {
    if (!active) return;
    try { active.g.gain.setTargetAtTime(0, audioCtx().currentTime, 0.03); active.src.stop(audioCtx().currentTime + 0.2); } catch (e) {}
    active.el.classList.remove('on');
    active = null;
  }
  $('kb').addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-midi]');
    if (!el || !S.notes) return;
    const note = S.notes.find((n) => n.midi === +el.dataset.midi);
    const c = audioCtx();
    if (c.state === 'suspended') c.resume();
    stopActive();
    const ab = c.createBuffer(1, note.samples.length, OUT_SR);
    ab.getChannelData(0).set(note.samples);
    const src = c.createBufferSource(), g = c.createGain();
    src.buffer = ab; src.connect(g); g.connect(c.destination); src.start();
    el.classList.add('on');
    active = { src, g, el };
    src.onended = () => el.classList.remove('on');
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('kb').addEventListener(ev, () => {
    if (active) { const a = active; setTimeout(() => { if (active === a) stopActive(); }, 250); }
  }));

  // arrastar arquivos para a área
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    $('files').files = e.dataTransfer.files;
    $('files').dispatchEvent(new Event('change'));
  });
})();
