(function () {
  'use strict';
  const D = window.ChromaDSP;
  const $ = (id) => document.getElementById(id);
  const MAX_SECONDS = 90;

  const S = { mode: 'single', raw: null, sources: [], notes: null, ctx: null, nextId: 1, busy: false };

  const audioCtx = () => (S.ctx = S.ctx || new (window.AudioContext || window.webkitAudioContext)());
  const fl = () => $('octmode').value === 'fl';
  const nname = (m) => D.noteName(m, fl());

  /* ---------- util UI ---------- */
  function progress(id, p, text) {
    const el = $(id);
    el.hidden = false;
    el.firstElementChild.style.width = Math.round(p * 100) + '%';
    el.lastElementChild.textContent = text || Math.round(p * 100) + '%';
  }
  const hide = (id) => ($(id).hidden = true);
  function msg(text) {
    const d = document.createElement('div');
    d.className = 'msg';
    d.textContent = text;
    return d;
  }
  function download(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* ---------- decodificação ---------- */
  async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    const ab = await new Promise((res, rej) => audioCtx().decodeAudioData(buf, res, rej));
    const n = Math.min(ab.length, Math.round(ab.sampleRate * MAX_SECONDS));
    const mono = new Float32Array(n);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const ch = ab.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += ch[i] / ab.numberOfChannels;
    }
    return { data: mono, sr: ab.sampleRate, truncated: ab.length > n, name: file.name };
  }

  /* ---------- tabs ---------- */
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
      S.mode = t.dataset.mode;
      $('mode-single').hidden = S.mode !== 'single';
      $('mode-parts').hidden = S.mode !== 'parts';
      S.sources = []; S.raw = null; S.notes = null;
      $('s-result').hidden = true;
      $('waveWrap').hidden = true;
      $('segs').innerHTML = '';
      $('btn-gen').disabled = true;
      $('btn-reanalyze').disabled = true;
    })
  );
  ['drop-single', 'drop-parts'].forEach((id) => {
    const el = $(id);
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); el.classList.remove('over');
      const inp = el.querySelector('input');
      inp.files = e.dataTransfer.files;
      inp.dispatchEvent(new Event('change'));
    });
  });

  /* ---------- análise ---------- */
  function segOptions() {
    const p = { strict: { minConf: 0.9, maxStd: 25, rmsRel: 0.1 }, normal: { minConf: 0.82, maxStd: 40, rmsRel: 0.08 }, loose: { minConf: 0.7, maxStd: 70, rmsRel: 0.05 } }[$('sens').value];
    return Object.assign({ minDur: parseFloat($('mindur').value), maxSegments: 14 }, p);
  }

  async function analyzeSingle() {
    if (!S.raw || S.busy) return;
    S.busy = true;
    $('segs').innerHTML = '';
    try {
      progress('prog-analyze', 0, 'Analisando tom…');
      if (!S.raw.track) S.raw.track = await D.analyzeTrack(S.raw.data, S.raw.sr, { onProgress: (p) => progress('prog-analyze', p, 'Analisando tom… ' + Math.round(p * 100) + '%') });
      const segs = D.findSegments(S.raw.data, S.raw.sr, S.raw.track, segOptions());
      S.sources = segs.map((s) => Object.assign(s, { id: S.nextId++, data: S.raw.data, sr: S.raw.sr, enabled: s.scoreNorm >= 0.25, name: S.raw.name }));
      drawWave();
      renderSegs();
      if (S.raw.truncated) $('segs').prepend(msg('Áudio longo: só os primeiros ' + MAX_SECONDS + ' s foram analisados.'));
      if (!segs.length) $('segs').appendChild(msg('Nenhum trecho com tom estável foi encontrado. Tente "Permissiva", uma duração mínima menor, ou uma gravação com vogais sustentadas ("aaaa", "oooo") e pouco ruído.'));
    } catch (e) {
      $('segs').appendChild(msg('Erro ao analisar: ' + e.message));
    }
    hide('prog-analyze');
    S.busy = false;
    $('btn-reanalyze').disabled = false;
    refreshGenButton();
  }

  $('file-single').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('drop-single-t').textContent = f.name;
    try {
      progress('prog-analyze', 0, 'Decodificando áudio…');
      S.raw = await decodeFile(f);
    } catch (err) {
      hide('prog-analyze');
      $('segs').innerHTML = '';
      $('segs').appendChild(msg('Não consegui abrir esse arquivo de áudio. Tente WAV ou MP3.'));
      return;
    }
    analyzeSingle();
  });
  $('btn-reanalyze').addEventListener('click', analyzeSingle);

  $('file-parts').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length || S.busy) return;
    S.busy = true;
    $('segs').innerHTML = '';
    S.sources = [];
    const loose = { minConf: 0.7, maxStd: 80, rmsRel: 0.05, minDur: 0.05, maxSegments: 1 };
    for (let i = 0; i < files.length; i++) {
      progress('prog-analyze', i / files.length, 'Analisando ' + (i + 1) + '/' + files.length + ': ' + files[i].name);
      try {
        const raw = await decodeFile(files[i]);
        const tr = await D.analyzeTrack(raw.data, raw.sr);
        const segs = D.findSegments(raw.data, raw.sr, tr, loose);
        if (!segs.length) { $('segs').appendChild(msg('Sem tom detectável em "' + files[i].name + '" — ignorado.')); continue; }
        S.sources.push(Object.assign(segs[0], { id: S.nextId++, data: raw.data, sr: raw.sr, enabled: true, name: files[i].name, scoreNorm: 1 }));
      } catch (err) {
        $('segs').appendChild(msg('Não consegui abrir "' + files[i].name + '".'));
      }
    }
    S.sources.forEach((s) => (s.scoreNorm = s.score / Math.max(...S.sources.map((q) => q.score))));
    hide('prog-analyze');
    renderSegs();
    S.busy = false;
    refreshGenButton();
  });

  /* ---------- lista de trechos ---------- */
  function noteOptions(sel) {
    let h = '';
    for (let m = 0; m <= 127; m++) h += `<option value="${m}"${m === sel ? ' selected' : ''}>${nname(m)}</option>`;
    return h;
  }

  function renderSegs() {
    const box = $('segs');
    Array.from(box.querySelectorAll('.seg')).forEach((n) => n.remove());
    S.sources.forEach((s) => {
      const nearest = Math.round(s.midi);
      const cents = Math.round((s.midi - nearest) * 100);
      const d = document.createElement('div');
      d.className = 'seg';
      d.innerHTML =
        `<input type="checkbox" ${s.enabled ? 'checked' : ''} aria-label="usar">` +
        `<div><span class="nm">${nname(nearest)}</span> <span class="meta">${cents >= 0 ? '+' : ''}${cents}¢ · ${s.f0.toFixed(1)} Hz</span>` +
        `<div class="meta">${s.name ? s.name.slice(0, 28) + ' · ' : ''}${(s.dur * 1000) | 0} ms · estabilidade ±${s.stdCents.toFixed(0)}¢` +
        `<span class="q" style="width:${Math.max(6, Math.round(s.scoreNorm * 60))}px"></span></div></div>` +
        `<div class="act"><select title="Corrigir nota">${noteOptions(nearest)}</select><button class="btn ghost sm">▶</button></div>`;
      const [cb, , act] = [d.children[0], d.children[1], d.children[2]];
      cb.addEventListener('change', () => { s.enabled = cb.checked; refreshGenButton(); drawWave(); });
      act.querySelector('select').addEventListener('change', (e) => {
        s.midi = parseInt(e.target.value, 10);
        s.f0 = D.midiToFreq(s.midi);
        renderSegs();
      });
      act.querySelector('button').addEventListener('click', () => playSlice(s));
      box.appendChild(d);
    });
  }

  function playSlice(s) {
    const c = audioCtx();
    if (c.state === 'suspended') c.resume();
    const len = s.b - s.a;
    const ab = c.createBuffer(1, len, s.sr);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const fade = Math.min(1, i / 200, (len - i) / 200);
      ch[i] = s.data[s.a + i] * fade;
    }
    const src = c.createBufferSource();
    src.buffer = ab; src.connect(c.destination); src.start();
  }

  function drawWave() {
    const raw = S.raw;
    if (!raw || S.mode !== 'single') return;
    $('waveWrap').hidden = false;
    const cv = $('wave');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = 110;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const n = raw.data.length;
    g.fillStyle = '#2d2360';
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * n), b = Math.floor(((x + 1) / w) * n);
      let mn = 0, mx = 0;
      for (let i = a; i < b; i += Math.max(1, ((b - a) / 40) | 0)) { const v = raw.data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      g.fillRect(x, h / 2 - mx * h * 0.9 / 2 * 1.6, 1, Math.max(1, (mx - mn) * h * 0.9 / 2 * 1.6));
    }
    S.sources.forEach((s) => {
      g.fillStyle = s.enabled ? 'rgba(255,79,163,.55)' : 'rgba(167,159,201,.25)';
      g.fillRect((s.a / n) * w, 0, Math.max(2, ((s.b - s.a) / n) * w), h);
    });
  }
  window.addEventListener('resize', () => drawWave());

  /* ---------- faixa do teclado ---------- */
  function fillRangeSelects() {
    const lo = +$('lo').value || 0, hi = +$('hi').value || 119;
    $('lo').innerHTML = noteOptions(lo);
    $('hi').innerHTML = noteOptions(hi);
  }
  function getRange() {
    if ($('preset').value === 'custom') return [+$('lo').value, +$('hi').value];
    return $('preset').value.split(',').map(Number);
  }
  function labelPresets() {
    const names = { '0,119': 'Teclado completo', '12,108': 'Faixa audível ampla', '24,96': 'Faixa média', '36,84': '3 oitavas centrais' };
    Array.from($('preset').options).forEach((o) => {
      if (!names[o.value]) return;
      const [l, h] = o.value.split(',').map(Number);
      o.textContent = `${names[o.value]} — ${nname(l)} a ${nname(h)}`;
    });
  }
  function updateRangeInfo() {
    labelPresets();
    const [lo, hi] = getRange();
    $('custom-range').hidden = $('preset').value !== 'custom';
    $('range-info').textContent = hi >= lo
      ? `${hi - lo + 1} notas: ${nname(lo)} (${D.midiToFreq(lo).toFixed(1)} Hz) até ${nname(hi)} (${D.midiToFreq(hi).toFixed(0)} Hz).`
      : 'A nota final precisa ser maior ou igual à inicial.';
  }
  $('preset').addEventListener('change', () => {
    if ($('preset').value !== 'custom') { const [l, h] = getRange(); $('lo').value = l; $('hi').value = h; }
    updateRangeInfo();
  });
  $('octmode').addEventListener('change', () => {
    const lo = $('lo').value, hi = $('hi').value;
    fillRangeSelects(); $('lo').value = lo; $('hi').value = hi;
    renderSegs(); updateRangeInfo();
  });
  $('lo').addEventListener('change', updateRangeInfo);
  $('hi').addEventListener('change', updateRangeInfo);
  fillRangeSelects(); $('lo').value = 0; $('hi').value = 119; updateRangeInfo();

  function refreshGenButton() {
    $('btn-gen').disabled = S.busy || !S.sources.some((s) => s.enabled);
  }

  /* ---------- geração ---------- */
  $('btn-gen').addEventListener('click', async () => {
    if (S.busy) return;
    const [lo, hi] = getRange();
    if (hi < lo) { alert('A nota final precisa ser maior ou igual à inicial.'); return; }
    const srcs = S.sources.filter((s) => s.enabled).map((s) => ({ data: s.data, a: s.a, b: s.b, f0: s.f0, sr: s.sr, id: s.id, midi: s.midi, scoreNorm: s.scoreNorm }));
    S.busy = true; $('btn-gen').disabled = true;
    const opts = { outSr: +$('outsr').value, noteLen: +$('notelen').value, mode: $('pickmode').value, normalize: $('norm').checked, flOctave: fl() };
    try {
      S.notes = await D.generateAll(srcs, lo, hi, opts, (p) => progress('prog-gen', p, 'Gerando notas… ' + Math.round(p * 100) + '%'));
      S.opts = opts;
      showResult(srcs);
    } catch (e) {
      alert('Erro ao gerar: ' + e.message);
    }
    hide('prog-gen');
    S.busy = false; refreshGenButton();
  });

  function fileOf(n) { return String(n.midi).padStart(3, '0') + '_' + n.name.replace('#', 's') + '.wav'; }

  function showResult(srcs) {
    const n = S.notes, o = S.opts;
    const maxShift = Math.max(...n.map((x) => Math.abs(x.shift)));
    const mb = (n.length * (o.noteLen * o.outSr) * (+$('bits').value / 8)) / 1048576;
    $('stats').innerHTML =
      `<span>${n.length} notas</span><span>${n[0].name} → ${n[n.length - 1].name}</span><span>${srcs.length} fonte(s)</span>` +
      `<span>≈ ${mb.toFixed(1)} MB</span><span>maior transposição: ${(maxShift / 12).toFixed(1)} oitavas</span>`;
    if (maxShift > 36 && srcs.length < 3) $('stats').appendChild(msg('Algumas teclas ficaram a mais de 3 oitavas da fonte; o timbre muda bastante. Com mais fontes em alturas diferentes o resultado fica mais natural.'));
    $('s-result').hidden = false;
    buildKeyboard();
    $('s-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('dl-wav').addEventListener('click', () => {
    const bits = +$('bits').value, o = S.opts;
    const wav = D.buildScaleWav(S.notes, { outSr: o.outSr, bits, gap: parseFloat($('gap').value) });
    download(wav, `chromatic_${S.notes[0].name}-${S.notes[S.notes.length - 1].name}.wav`.replace(/#/g, 's'), 'audio/wav');
  });
  $('dl-zip').addEventListener('click', () => {
    const bits = +$('bits').value, o = S.opts;
    S.notes.forEach((n) => (n.file = fileOf(n)));
    const files = S.notes.map((n) => ({ name: 'samples/' + n.file, data: D.encodeWav(n.samples, o.outSr, bits, { rootNote: n.midi }) }));
    files.push({ name: 'chromatic.sfz', data: new TextEncoder().encode(D.buildSfz(S.notes, 'samples/')) });
    download(D.buildZip(files), 'chromatic_pack.zip', 'application/zip');
  });

  /* ---------- teclado de teste ---------- */
  function buildKeyboard() {
    const kb = $('kb');
    kb.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'in';
    const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
    let whiteIdx = 0;
    const blacks = [];
    S.notes.forEach((n) => {
      const el = document.createElement('div');
      el.dataset.midi = n.midi;
      el.title = n.name;
      if (isBlack(n.midi)) { el.className = 'b'; blacks.push([el, whiteIdx]); }
      else { el.className = 'w'; el.style.left = whiteIdx * 26 + 'px'; if (n.midi % 12 === 0) el.textContent = n.name; whiteIdx++; }
      inner.appendChild(el);
    });
    blacks.forEach(([el, wi]) => (el.style.left = wi * 26 - 8 + 'px'));
    inner.style.width = whiteIdx * 26 + 'px';
    kb.appendChild(inner);
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
    const ab = c.createBuffer(1, note.samples.length, S.opts.outSr);
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
})();
