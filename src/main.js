import './style.css';
import { db, newId } from './lib/db.js';
import { formatClock, formatDate, toMarkdown, toPlainText, toSrt, slugify, normalizeSegments } from './lib/format.js';
import { localSummary } from './lib/summary.js';
import { MODELS, LANGUAGES } from './lib/transcribe.js';
import { PROVIDERS, aiSummary } from './lib/ai.js';
import { Recorder, decodeTo16kMono } from './capture.js';

/* ---------- small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = {
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>',
  upload: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 11v2.5h11V11"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>',
  menu: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/></svg>',
  gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>',
};
const mark = `<svg class="brand-mark" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0A0A0A"/><rect x="7" y="13" width="3" height="6" fill="#FFD60A"/><rect x="12.5" y="9" width="3" height="14" fill="#FFD60A"/><rect x="18" y="11" width="3" height="10" fill="#FFD60A"/><rect x="23.5" y="14" width="3" height="4" fill="#FFD60A"/></svg>`;

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = `toast${err ? ' err' : ''}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 5000 : 2200);
}

function download(name, text, type = 'text/plain') {
  const blob = text instanceof Blob ? text : new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- settings (localStorage only) ---------- */
const SETTINGS_KEY = 'owm.settings';
const AI_KEY = 'owm.ai';
const settings = Object.assign({ model: 'base', language: 'auto', device: 'auto', includeSystem: false }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
const ai = Object.assign({ provider: 'openai', baseUrl: '', model: '', apiKey: '' }, JSON.parse(localStorage.getItem(AI_KEY) || '{}'));
const saveAi = () => localStorage.setItem(AI_KEY, JSON.stringify(ai));

/* ---------- worker ---------- */
let worker;
const job = { meetingId: null, running: false, modelLoaded: 0, modelTotal: 0, modelReady: false, index: 0, total: 0, status: '', device: '' };
let jobResolve = null;
let jobReject = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    if (jobReject) jobReject(new Error(e.message || 'Worker crashed'));
  };
  return worker;
}

async function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'model-progress') {
    job.modelLoaded = m.loaded;
    job.modelTotal = m.total;
    renderProgress();
  } else if (m.type === 'status') {
    job.status = m.message;
    renderProgress();
  } else if (m.type === 'ready') {
    job.modelReady = true;
    job.device = m.device;
    renderProgress();
  } else if (m.type === 'language') {
    const meeting = state.liveMeeting;
    if (meeting) {
      meeting.language = m.language;
      job.status = `Detected ${LANGUAGES[m.language] || m.language}, transcribing`;
      if (state.current && state.current.id === meeting.id) {
        state.current.language = m.language;
        renderMeta();
      }
    }
    renderProgress();
  } else if (m.type === 'segment') {
    job.index = m.index + 1;
    job.total = m.total;
    const meeting = state.liveMeeting;
    if (meeting && meeting.id === job.meetingId) {
      meeting.segments.push(...m.segments);
      if (m.language) meeting.language = m.language;
      await db.update(meeting.id, { segments: meeting.segments, language: meeting.language });
      if (state.current && state.current.id === meeting.id) {
        state.current.segments = meeting.segments;
        renderTranscript();
      }
    }
    renderProgress();
  } else if (m.type === 'done') {
    jobResolve && jobResolve(m);
  } else if (m.type === 'error') {
    jobReject && jobReject(new Error(m.message));
  }
}

function runWorker(payload, transfer) {
  return new Promise((resolve, reject) => {
    jobResolve = resolve;
    jobReject = reject;
    getWorker().postMessage(payload, transfer);
  });
}

/* ---------- app state ---------- */
const state = { meetings: [], current: null, liveMeeting: null, search: '', searchIdx: 0, editing: false, tab: 'summary', recorder: null };

/* ---------- shell ---------- */
function shell() {
  document.getElementById('app').innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn btn-ghost btn-sm menu-btn" id="menuBtn" aria-label="Library">${icon.menu}</button>
        <a class="brand" href="#/">${mark}<b>openworld</b><span>/</span><b>minutes</b></a>
      </div>
      <div class="topbar-right">
        <span class="privacy-pill" id="privacyPill"><i class="dot"></i><span>Local only. Audio stays on this device.</span></span>
        <a class="btn btn-ghost btn-sm" href="https://github.com/jairemanuels/openworld-minutes" target="_blank" rel="noopener">GitHub</a>
        <button class="btn btn-sm" id="settingsBtn">${icon.gear}<span>Settings</span></button>
      </div>
    </header>
    <div class="body">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-head">
          <a class="btn btn-primary btn-block" href="#/">${icon.plus}<span>New meeting</span></a>
          <div class="searchbox" style="max-width:none">${icon.search}<input class="input" id="libSearch" placeholder="Filter meetings" /></div>
        </div>
        <div class="library" id="library"></div>
        <div class="sidebar-foot">Stored in this browser (IndexedDB). <a href="https://github.com/jairemanuels/openworld-minutes" target="_blank" rel="noopener">Open source, MIT</a>.</div>
      </aside>
      <main class="main" id="main"></main>
    </div>
  </div>
  ${settingsDialog()}`;
  $('#settingsBtn').onclick = openSettings;
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
  $('#libSearch').oninput = renderLibrary;
  bindSettings();
  updatePrivacyPill();
}

function updatePrivacyPill() {
  const pill = $('#privacyPill');
  if (!pill) return;
  const on = !!ai.apiKey;
  pill.innerHTML = on
    ? `<i class="dot on"></i><span>Local transcription. AI summary key set (${esc(PROVIDERS[ai.provider].label)}).</span>`
    : `<i class="dot"></i><span>Local only. Audio stays on this device.</span>`;
}

async function refreshLibrary() {
  state.meetings = await db.list();
  renderLibrary();
}

function renderLibrary() {
  const el = $('#library');
  if (!el) return;
  const q = ($('#libSearch')?.value || '').toLowerCase().trim();
  const list = state.meetings.filter((m) => !q || (m.title || '').toLowerCase().includes(q) || (m.segments || []).some((s) => s.text.toLowerCase().includes(q)));
  if (!list.length) {
    el.innerHTML = `<div class="library-empty">${q ? 'No meetings match.' : 'No meetings yet. Record or upload one to get started.'}</div>`;
    return;
  }
  const activeId = state.current?.id;
  el.innerHTML = list
    .map(
      (m) => `<a class="lib-item${m.id === activeId ? ' active' : ''}" href="#/m/${m.id}" style="text-decoration:none">
      <div class="lib-title">${esc(m.title || 'Untitled meeting')}</div>
      <div class="lib-meta"><span>${esc(formatDate(m.createdAt))}</span><span>${formatClock(m.duration || 0)}</span>${m.status === 'transcribing' ? '<span>transcribing</span>' : ''}${m.status === 'error' ? '<span>error</span>' : ''}</div>
    </a>`,
    )
    .join('');
}

/* ---------- settings dialog ---------- */
function settingsDialog() {
  return `<dialog id="settings">
    <form method="dialog">
      <div class="dialog-head"><h3 style="margin:0">Settings</h3><button class="btn btn-ghost btn-sm" value="close">Close</button></div>
      <div class="dialog-body">
        <div>
          <h2>Transcription</h2>
          <div class="options" style="margin-top:0">
            <div class="field"><label for="setModel">Model</label><select class="select" id="setModel">${modelOptions()}</select></div>
            <div class="field"><label for="setLang">Language</label><select class="select" id="setLang">${langOptions()}</select></div>
            <div class="field"><label for="setDevice">Engine</label><select class="select" id="setDevice">
              <option value="auto">Auto (WebGPU if available)</option><option value="wasm">WASM (CPU)</option></select></div>
          </div>
        </div>
        <div>
          <h2>Optional AI summary</h2>
          <div class="warn">Bring your own key. It is stored only in this browser (localStorage) and sent only to the API you choose below, together with the transcript text. Audio is never uploaded.</div>
        </div>
        <div class="field"><label for="aiProvider">Provider</label>
          <select class="select" id="aiProvider">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="aiBase">API base URL</label><input class="input mono" id="aiBase" placeholder="" /></div>
        <div class="field"><label for="aiModel">Model</label><input class="input mono" id="aiModel" placeholder="" /></div>
        <div class="field"><label for="aiKey">API key</label><input class="input mono" id="aiKey" type="password" autocomplete="off" placeholder="sk-..." /></div>
        <p class="hint" style="margin:0">OpenAI-compatible works with OpenAI, OpenRouter, Groq, Mistral, a local Ollama or LM Studio server, and others that accept browser requests (CORS).</p>
      </div>
      <div class="dialog-foot">
        <button class="btn btn-danger btn-sm" type="button" id="aiClear">Forget key</button>
        <button class="btn btn-primary btn-sm" value="save" id="settingsSave">Save</button>
      </div>
    </form>
  </dialog>`;
}

const modelOptions = (sel = settings.model) => Object.entries(MODELS).map(([k, m]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${m.label}: ${m.note}</option>`).join('');
const langOptions = (sel = settings.language) => Object.entries(LANGUAGES).map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');

function fillAiFields() {
  const p = PROVIDERS[$('#aiProvider').value];
  $('#aiBase').placeholder = p.baseUrl;
  $('#aiModel').placeholder = p.model;
}

function openSettings() {
  $('#setModel').value = settings.model;
  $('#setLang').value = settings.language;
  $('#setDevice').value = settings.device;
  $('#aiProvider').value = ai.provider;
  $('#aiBase').value = ai.baseUrl;
  $('#aiModel').value = ai.model;
  $('#aiKey').value = ai.apiKey;
  fillAiFields();
  $('#settings').showModal();
}

function bindSettings() {
  $('#aiProvider').onchange = fillAiFields;
  $('#settingsSave').onclick = () => {
    settings.model = $('#setModel').value;
    settings.language = $('#setLang').value;
    settings.device = $('#setDevice').value;
    saveSettings();
    ai.provider = $('#aiProvider').value;
    ai.baseUrl = $('#aiBase').value.trim();
    ai.model = $('#aiModel').value.trim();
    ai.apiKey = $('#aiKey').value.trim();
    saveAi();
    updatePrivacyPill();
    syncOptionSelects();
    if (state.current) renderSummary();
    toast('Settings saved');
  };
  $('#aiClear').onclick = () => {
    ai.apiKey = '';
    $('#aiKey').value = '';
    saveAi();
    updatePrivacyPill();
    if (state.current) renderSummary();
    toast('Key removed from this browser');
  };
}

function syncOptionSelects() {
  for (const id of ['optModel', 'reModel']) if ($(`#${id}`)) $(`#${id}`).value = settings.model;
  for (const id of ['optLang', 'reLang']) if ($(`#${id}`)) $(`#${id}`).value = settings.language;
}

/* ---------- home / capture view ---------- */
function renderHome() {
  state.current = null;
  renderLibrary();
  const hasGpu = 'gpu' in navigator;
  const canDisplay = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  $('#main').innerHTML = `
  <div class="page">
    <div class="eyebrow"><span class="bar"></span>Private meeting notes</div>
    <h1>Record. Transcribe. Summarise. All in your browser.</h1>
    <p class="lead">Whisper runs on your own machine through WebGPU or WebAssembly. Nothing is uploaded: the model is downloaded once and cached, then your audio is processed locally.</p>

    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2 style="margin:0">Record</h2><span class="count" id="recState">ready</span></div>
        <div class="recorder">
          <div class="rec-row">
            <button class="rec-button" id="recBtn" aria-label="Start recording"><span class="core"></span></button>
            <div style="flex:1">
              <div class="timer" id="recTimer">00:00</div>
              <div class="meters">
                <div class="meter-label"><span>Microphone</span></div>
                <div class="meter" id="meterMic"><div></div></div>
                <div id="sysMeterWrap" class="hidden">
                  <div class="meter-label"><span>Tab / system audio</span></div>
                  <div class="meter" id="meterSys"><div></div></div>
                </div>
              </div>
            </div>
          </div>
          <label class="check"><input type="checkbox" id="includeSystem" ${settings.includeSystem ? 'checked' : ''} ${canDisplay ? '' : 'disabled'} />
            <span>Also capture tab or system audio<br><span class="hint">For online meetings: pick the meeting tab and enable "share audio". Best supported in Chrome and Edge.</span></span></label>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" id="pauseBtn" disabled>Pause</button>
            <button class="btn btn-sm btn-primary" id="stopBtn" disabled>Stop and transcribe</button>
            <button class="btn btn-sm btn-ghost" id="discardBtn" disabled>Discard</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2 style="margin:0">Upload</h2><span class="count">audio or video</span></div>
        <label class="drop" id="drop">
          ${icon.upload.replace('<svg', '<svg style="width:22px;height:22px"')}
          <strong>Drop a recording here or click to choose</strong>
          <span class="formats">mp3  m4a  wav  webm  mp4  ogg</span>
          <input type="file" id="fileInput" accept="audio/*,video/*,.mp3,.m4a,.wav,.webm,.mp4,.ogg,.oga,.flac,.aac,.mov" hidden />
        </label>
        <p class="hint" style="margin:12px 0 0">Long meetings are fine: audio is processed in 30 second windows. A 60 minute meeting takes a few minutes on WebGPU and longer on CPU.</p>
      </section>
    </div>

    <div class="options">
      <div class="field"><label for="optModel">Model</label><select class="select" id="optModel">${modelOptions()}</select></div>
      <div class="field"><label for="optLang">Language</label><select class="select" id="optLang">${langOptions()}</select></div>
      <div class="field"><label>Engine</label><div class="input mono" style="display:flex;align-items:center;font-size:12px;color:var(--muted)">${hasGpu ? 'WebGPU available, WASM fallback' : 'WASM (WebGPU not available)'}</div></div>
    </div>

    <div class="features">
      <div class="feature"><div class="k">01 / private</div><p>Transcription runs on-device. No account, no server, no upload.</p></div>
      <div class="feature"><div class="k">02 / bilingual</div><p>English and Dutch with auto-detect, or force a language.</p></div>
      <div class="feature"><div class="k">03 / summaries</div><p>Local summary, action items and topics. Optional AI summary with your own key.</p></div>
      <div class="feature"><div class="k">04 / exports</div><p>Markdown, plain text and SRT subtitles, or copy to clipboard.</p></div>
    </div>
  </div>`;

  $('#optModel').onchange = (e) => { settings.model = e.target.value; saveSettings(); };
  $('#optLang').onchange = (e) => { settings.language = e.target.value; saveSettings(); };
  $('#includeSystem').onchange = (e) => { settings.includeSystem = e.target.checked; saveSettings(); };

  const input = $('#fileInput');
  input.onchange = () => input.files[0] && handleFile(input.files[0]);
  const drop = $('#drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  $('#recBtn').onclick = toggleRecording;
  $('#stopBtn').onclick = stopRecording;
  $('#pauseBtn').onclick = pauseRecording;
  $('#discardBtn').onclick = discardRecording;
  if (state.recorder) setRecUi(true);
}

function setRecUi(live) {
  const btn = $('#recBtn');
  if (!btn) return;
  btn.classList.toggle('live', live);
  btn.setAttribute('aria-label', live ? 'Stop recording' : 'Start recording');
  $('#stopBtn').disabled = !live;
  $('#pauseBtn').disabled = !live;
  $('#discardBtn').disabled = !live;
  $('#includeSystem').disabled = live;
  $('#recState').textContent = live ? 'recording' : 'ready';
  $('#sysMeterWrap').classList.toggle('hidden', !(live && state.recorder && state.recorder.analysers && state.recorder.analysers.system));
}

async function toggleRecording() {
  if (state.recorder) return stopRecording();
  if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
    toast('Recording is not supported in this browser', true);
    return;
  }
  const rec = new Recorder({
    onLevel: (levels, elapsed) => {
      const t = $('#recTimer');
      if (t) t.textContent = formatClock(elapsed);
      for (const [k, id] of [['mic', '#meterMic'], ['system', '#meterSys']]) {
        const el = $(id);
        if (el && levels[k] != null) {
          el.firstElementChild.style.width = `${Math.round(levels[k] * 100)}%`;
          el.classList.toggle('hot', levels[k] > 0.85);
        }
      }
    },
  });
  try {
    await rec.start({ includeSystem: settings.includeSystem });
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Microphone permission was denied' : err.message, true);
    return;
  }
  state.recorder = rec;
  setRecUi(true);
  window.addEventListener('beforeunload', beforeUnload);
}

function beforeUnload(e) {
  if (state.recorder || job.running) {
    e.preventDefault();
    e.returnValue = '';
  }
}

function pauseRecording() {
  const r = state.recorder;
  if (!r) return;
  if (r.media.state === 'recording') {
    r.pause();
    $('#pauseBtn').textContent = 'Resume';
    $('#recState').textContent = 'paused';
  } else {
    r.resume();
    $('#pauseBtn').textContent = 'Pause';
    $('#recState').textContent = 'recording';
  }
}

async function discardRecording() {
  if (!state.recorder) return;
  if (!confirm('Discard this recording?')) return;
  await state.recorder.stop();
  state.recorder = null;
  setRecUi(false);
  $('#recTimer').textContent = '00:00';
}

async function stopRecording() {
  const r = state.recorder;
  if (!r) return;
  state.recorder = null;
  const res = await r.stop();
  setRecUi(false);
  if (!res || !res.blob.size) {
    toast('Nothing was recorded', true);
    return;
  }
  const now = new Date();
  const title = `Meeting ${now.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  await createAndTranscribe({ title, blob: res.blob, duration: res.duration, source: settings.includeSystem ? 'mic+system' : 'mic' });
}

async function handleFile(file) {
  if (!/^(audio|video)\//.test(file.type) && !/\.(mp3|m4a|wav|webm|mp4|ogg|oga|flac|aac|mov)$/i.test(file.name)) {
    toast('Please choose an audio or video file', true);
    return;
  }
  const title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Uploaded meeting';
  await createAndTranscribe({ title, blob: file, duration: 0, source: 'upload', fileName: file.name });
}

/* ---------- transcription flow ---------- */
async function createAndTranscribe({ title, blob, duration, source, fileName }) {
  if (job.running) {
    toast('A transcription is already running. Wait for it to finish.', true);
    return;
  }
  const meeting = {
    id: newId(),
    title,
    createdAt: Date.now(),
    duration,
    source,
    fileName: fileName || null,
    audio: blob,
    mime: blob.type || '',
    segments: [],
    summary: null,
    aiSummary: null,
    status: 'transcribing',
    model: settings.model,
    languageSetting: settings.language,
    language: settings.language === 'auto' ? null : settings.language,
  };
  await db.put(meeting);
  await refreshLibrary();
  location.hash = `#/m/${meeting.id}`;
  await transcribeMeeting(meeting);
}

async function transcribeMeeting(meeting, { model = settings.model, language = settings.language } = {}) {
  Object.assign(job, { meetingId: meeting.id, running: true, index: 0, total: 0, status: 'Decoding audio', modelLoaded: 0, modelTotal: 0, modelReady: false });
  state.liveMeeting = meeting;
  meeting.segments = [];
  meeting.status = 'transcribing';
  meeting.model = model;
  meeting.languageSetting = language;
  await db.update(meeting.id, { segments: [], status: 'transcribing', model, languageSetting: language, error: null });
  if (state.current && state.current.id === meeting.id) {
    Object.assign(state.current, { segments: [], status: 'transcribing', error: null });
    renderMeetingBody();
  }
  window.addEventListener('beforeunload', beforeUnload);
  try {
    const { samples, duration } = await decodeTo16kMono(meeting.audio);
    if (!meeting.duration || Math.abs(meeting.duration - duration) > 1) meeting.duration = duration;
    await db.update(meeting.id, { duration: meeting.duration });
    if (state.current && state.current.id === meeting.id) {
      state.current.duration = meeting.duration;
      renderMeta();
    }
    job.status = 'Loading model';
    renderProgress();
    const res = await runWorker({ type: 'transcribe', audio: samples, model, language, device: settings.device }, [samples.buffer]);
    const segments = normalizeSegments(meeting.segments);
    const summary = localSummary(segments);
    const patch = {
      segments,
      status: 'done',
      language: res.language || summary.language || null,
      summary,
      engine: res.device,
      processingSeconds: Math.round(res.seconds),
    };
    Object.assign(meeting, patch);
    await db.update(meeting.id, patch);
    toast(res.stopped ? 'Transcription stopped' : `Transcribed in ${formatClock(res.seconds)}`);
  } catch (err) {
    console.error(err);
    meeting.status = 'error';
    meeting.error = err.message;
    await db.update(meeting.id, { status: 'error', error: err.message, segments: normalizeSegments(meeting.segments) });
    toast(err.message, true);
  } finally {
    job.running = false;
    state.liveMeeting = null;
    await refreshLibrary();
    if (state.current && state.current.id === meeting.id) {
      state.current = { ...(await db.get(meeting.id)) };
      renderMeetingBody();
    }
  }
}

/* ---------- meeting view ---------- */
let audioUrl = null;

async function renderMeeting(id) {
  const m = await db.get(id);
  if (!m) {
    location.hash = '#/';
    return;
  }
  if (state.liveMeeting && state.liveMeeting.id === id) m.segments = state.liveMeeting.segments;
  state.current = m;
  state.search = '';
  state.editing = false;
  renderLibrary();
  $('#sidebar').classList.remove('open');
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = m.audio ? URL.createObjectURL(m.audio) : null;
  const isVideo = m.mime && m.mime.startsWith('video/');
  $('#main').innerHTML = `
  <div class="page">
    <div class="meeting-head">
      <div style="flex:1;min-width:0">
        <input class="title-input" id="titleInput" value="${esc(m.title)}" aria-label="Meeting title" />
        <div class="meta" id="meta"></div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-sm btn-danger" id="deleteBtn">Delete</button>
      </div>
    </div>
    ${audioUrl ? (isVideo ? `<video class="player" id="player" controls src="${audioUrl}" style="height:auto;max-height:260px;background:#000;border-radius:8px"></video>` : `<audio class="player" id="player" controls src="${audioUrl}"></audio>`) : ''}
    <div id="meetingBody"></div>
  </div>`;
  const title = $('#titleInput');
  title.onchange = async () => {
    const t = title.value.trim() || 'Untitled meeting';
    title.value = t;
    state.current.title = t;
    await db.update(id, { title: t });
    await refreshLibrary();
    toast('Renamed');
  };
  title.onkeydown = (e) => e.key === 'Enter' && title.blur();
  $('#deleteBtn').onclick = async () => {
    if (job.running && job.meetingId === id) {
      toast('Stop the transcription first', true);
      return;
    }
    if (!confirm(`Delete "${state.current.title}"? This removes the audio and transcript from this browser.`)) return;
    await db.delete(id);
    await refreshLibrary();
    location.hash = '#/';
    toast('Meeting deleted');
  };
  const player = $('#player');
  if (player) player.ontimeupdate = highlightPlaying;
  renderMeta();
  renderMeetingBody();
}

function renderMeta() {
  const m = state.current;
  if (!m || !$('#meta')) return;
  const words = (m.segments || []).reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  const lang = m.language ? (LANGUAGES[m.language] || m.language).replace(/ \(.*\)/, '') : m.languageSetting === 'auto' ? 'auto' : '';
  $('#meta').innerHTML = [
    `<span>${esc(formatDate(m.createdAt))}</span>`,
    `<span>${formatClock(m.duration || 0)}</span>`,
    words ? `<span>${words} words</span>` : '',
    lang ? `<span class="tag">${esc(lang)}</span>` : '',
    m.model ? `<span class="tag">whisper-${esc(m.model)}${m.engine ? ` / ${esc(m.engine)}` : ''}</span>` : '',
    m.status === 'transcribing' ? '<span class="tag live">transcribing</span>' : '',
  ].join('');
}

function renderMeetingBody() {
  const m = state.current;
  if (!m || !$('#meetingBody')) return;
  renderMeta();
  $('#meetingBody').innerHTML = `
    <div id="progressWrap"></div>
    ${m.status === 'error' ? `<div class="warn" style="margin-bottom:16px">Transcription failed: ${esc(m.error || 'unknown error')}. Try again, or choose a smaller model or the WASM engine in Settings.</div>` : ''}
    <div class="cols">
      <section class="panel">
        <div class="panel-head">
          <div class="searchbox">${icon.search}<input class="input" id="tSearch" placeholder="Search transcript" value="${esc(state.search)}" /></div>
          <span class="count" id="tCount"></span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm" id="editBtn">${state.editing ? 'Done editing' : 'Edit'}</button>
          </div>
        </div>
        <div class="transcript ${state.editing ? 'editing' : ''}" id="transcript"></div>
      </section>
      <aside class="sticky" style="display:grid;gap:16px">
        <section class="panel">
          <div class="panel-head">
            <div class="tabs">
              <button class="tab ${state.tab === 'summary' ? 'active' : ''}" data-tab="summary">Summary</button>
              <button class="tab ${state.tab === 'ai' ? 'active' : ''}" data-tab="ai">AI summary</button>
            </div>
          </div>
          <div class="panel-body" id="summary"></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2 style="margin:0">Export</h2></div>
          <div class="panel-body">
            <div class="export-grid">
              <button class="btn btn-sm" data-export="md">Markdown</button>
              <button class="btn btn-sm" data-export="txt">Text</button>
              <button class="btn btn-sm" data-export="srt">SRT subtitles</button>
              <button class="btn btn-sm" data-export="copy">Copy</button>
              <button class="btn btn-sm btn-accent" data-export="share" style="grid-column:1/-1">Share as .md file</button>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2 style="margin:0">Transcribe again</h2></div>
          <div class="panel-body" style="display:grid;gap:10px">
            <div class="field"><label for="reModel">Model</label><select class="select" id="reModel">${modelOptions(m.model || settings.model)}</select></div>
            <div class="field"><label for="reLang">Language</label><select class="select" id="reLang">${langOptions(m.languageSetting || settings.language)}</select></div>
            <button class="btn btn-sm" id="reBtn" ${!m.audio ? 'disabled' : ''}>Re-transcribe</button>
          </div>
        </section>
      </aside>
    </div>`;

  $('#tSearch').oninput = (e) => {
    state.search = e.target.value;
    state.searchIdx = 0;
    renderTranscript();
  };
  $('#tSearch').onkeydown = (e) => {
    if (e.key === 'Enter') {
      state.searchIdx += e.shiftKey ? -1 : 1;
      focusMatch();
    } else if (e.key === 'Escape') {
      e.target.value = '';
      state.search = '';
      renderTranscript();
    }
  };
  $('#editBtn').onclick = () => {
    if (m.status === 'transcribing') {
      toast('Wait until transcription finishes to edit', true);
      return;
    }
    state.editing = !state.editing;
    renderMeetingBody();
  };
  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderMeetingBody(); }));
  document.querySelectorAll('[data-export]').forEach((b) => (b.onclick = () => exportAs(b.dataset.export)));
  $('#reBtn').onclick = () => {
    if (job.running) {
      toast('A transcription is already running', true);
      return;
    }
    if (m.segments.length && !confirm('Replace the current transcript (including your edits)?')) return;
    transcribeMeeting(state.current, { model: $('#reModel').value, language: $('#reLang').value });
  };
  renderProgress();
  renderTranscript();
  renderSummary();
}

function renderProgress() {
  const wrap = $('#progressWrap');
  if (!wrap) return;
  const m = state.current;
  if (!m || !job.running || job.meetingId !== m.id) {
    wrap.innerHTML = '';
    return;
  }
  const modelPct = job.modelTotal ? Math.min(100, (job.modelLoaded / job.modelTotal) * 100) : 0;
  const tPct = job.total ? (job.index / job.total) * 100 : 0;
  const mb = (b) => (b / 1048576).toFixed(1);
  wrap.innerHTML = `<section class="card progress-card" style="margin:0 0 16px">
    <div class="prow"><span>${esc(job.status || 'Working')}</span><button class="btn btn-sm btn-ghost" id="stopJob">Stop</button></div>
    <div class="prow" style="margin-top:8px"><span>Model ${job.modelReady ? 'ready' : 'download'}</span><span>${job.modelReady ? esc(job.device.toUpperCase()) : job.modelTotal ? `${mb(job.modelLoaded)} / ${mb(job.modelTotal)} MB` : 'checking cache'}</span></div>
    <div class="pbar"><div style="width:${job.modelReady ? 100 : modelPct}%"></div></div>
    <div class="prow" style="margin-top:8px"><span>Transcription</span><span>${job.total ? `part ${Math.min(job.index + 1, job.total)} of ${job.total}${job.index ? ` / ${Math.round(tPct)}%` : ''}` : 'waiting'}</span></div>
    <div class="pbar accent ${job.modelReady && job.index < (job.total || 1) ? 'indeterminate' : ''}"><div style="width:${tPct}%"></div></div>
    <p class="hint" style="margin:8px 0 0">The first run downloads the model and caches it in your browser. Keep this tab open; the transcript fills in as parts finish.</p>
  </section>`;
  $('#stopJob').onclick = () => {
    worker && worker.postMessage({ type: 'stop' });
    job.status = 'Stopping after the current part';
    renderProgress();
  };
  renderMeta();
}

function highlight(text, q) {
  if (!q) return esc(text);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let out = '';
  let last = 0;
  for (const mt of text.matchAll(re)) {
    out += esc(text.slice(last, mt.index)) + `<mark>${esc(mt[0])}</mark>`;
    last = mt.index + mt[0].length;
  }
  return out + esc(text.slice(last));
}

function renderTranscript() {
  const el = $('#transcript');
  const m = state.current;
  if (!el || !m) return;
  const segs = m.segments || [];
  if (!segs.length) {
    el.innerHTML = `<div class="empty">${m.status === 'transcribing' ? 'Transcript will appear here as each part is processed.' : 'No speech was detected.'}</div>`;
    $('#tCount').textContent = '';
    return;
  }
  const q = state.editing ? '' : state.search.trim();
  el.innerHTML = segs
    .map(
      (s, i) => `<div class="line" data-i="${i}" data-start="${s.start}">
        <button class="ts" tabindex="-1">${formatClock(s.start)}</button>
        <div class="tx" ${state.editing ? 'contenteditable="plaintext-only" spellcheck="true"' : ''}>${highlight(s.text, q)}</div>
      </div>`,
    )
    .join('');
  const count = q ? el.querySelectorAll('mark').length : 0;
  $('#tCount').textContent = q ? `${count} match${count === 1 ? '' : 'es'}` : `${segs.length} lines`;
  el.onclick = (e) => {
    const line = e.target.closest('.line');
    if (!line) return;
    if (state.editing && !e.target.classList.contains('ts')) return;
    seek(Number(line.dataset.start));
  };
  if (state.editing) {
    el.querySelectorAll('.tx').forEach((tx) => {
      tx.onblur = async () => {
        const i = Number(tx.parentElement.dataset.i);
        const text = tx.textContent.replace(/\s+/g, ' ').trim();
        if (text === m.segments[i].text) return;
        if (!text) {
          m.segments.splice(i, 1);
        } else {
          m.segments[i].text = text;
        }
        m.summary = localSummary(m.segments);
        await db.update(m.id, { segments: m.segments, summary: m.summary, edited: true });
        if (!text) renderTranscript();
        renderSummary();
      };
      tx.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          tx.blur();
        }
      };
    });
  }
  if (q) focusMatch(false);
}

function focusMatch(scroll = true) {
  const marks = [...document.querySelectorAll('#transcript mark')];
  if (!marks.length) return;
  const n = marks.length;
  state.searchIdx = ((state.searchIdx % n) + n) % n;
  marks.forEach((mk, i) => mk.classList.toggle('current', i === state.searchIdx));
  if (scroll) marks[state.searchIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#tCount').textContent = `${state.searchIdx + 1} / ${n}`;
}

function seek(t) {
  const p = $('#player');
  if (!p || Number.isNaN(t)) return;
  p.currentTime = Math.max(0, t);
  p.play().catch(() => {});
}

function highlightPlaying() {
  const p = $('#player');
  const segs = state.current?.segments || [];
  if (!p || !segs.length) return;
  const t = p.currentTime;
  let idx = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].start <= t + 0.05) idx = i;
    else break;
  }
  const prev = document.querySelector('.line.playing');
  const next = idx >= 0 ? document.querySelector(`.line[data-i="${idx}"]`) : null;
  if (prev === next) return;
  prev && prev.classList.remove('playing');
  if (next) {
    next.classList.add('playing');
    if (!state.editing && !p.paused) {
      const box = $('#transcript');
      const r = next.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) next.scrollIntoView({ block: 'nearest' });
    }
  }
}

const jump = (t) => (t == null ? '' : `<button class="jump" data-seek="${t}">${formatClock(t)}</button>`);

function renderSummary() {
  const el = $('#summary');
  const m = state.current;
  if (!el || !m) return;
  if (state.tab === 'ai') return renderAiSummary(el, m);
  const s = m.summary;
  if (!s) {
    el.innerHTML = `<p class="muted" style="margin:0">${m.status === 'transcribing' ? 'The summary is generated when transcription finishes.' : 'No summary yet.'}</p>`;
    return;
  }
  el.innerHTML = `
    <div class="summary-block"><h3>Key points</h3>
      ${s.overview.length ? `<ul class="slist">${s.overview.map((o) => `<li>${esc(o.text)}${jump(o.start)}</li>`).join('')}</ul>` : '<p class="faint" style="margin:0">Not enough speech to summarise.</p>'}
    </div>
    <div class="summary-block"><h3>Action items</h3>
      ${s.actionItems.length ? `<ul class="slist" style="gap:10px">${s.actionItems.map((a) => `<li class="todo" style="padding:0"><span class="box"></span><span>${esc(a.text)}<span class="todo-meta">${a.owner ? `<span class="who">${esc(a.owner)}</span>` : ''}${a.due ? `<span>due ${esc(a.due)}</span>` : ''}${jump(a.start)}</span></span></li>`).join('')}</ul>` : '<p class="faint" style="margin:0">No action items detected.</p>'}
    </div>
    <div class="summary-block"><h3>Topics</h3>
      ${s.topics.length ? `<div class="chips">${s.topics.map((t) => `<button class="chip" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : '<p class="faint" style="margin:0">None.</p>'}
    </div>
    <p class="hint" style="margin:0">Generated on this device with keyword heuristics. Use the AI summary tab for a written overview.</p>`;
  bindSummaryClicks(el);
}

function bindSummaryClicks(el) {
  el.querySelectorAll('[data-seek]').forEach((b) => (b.onclick = () => seek(Number(b.dataset.seek))));
  el.querySelectorAll('[data-topic]').forEach((b) => (b.onclick = () => {
    state.search = b.dataset.topic;
    state.searchIdx = 0;
    $('#tSearch').value = state.search;
    renderTranscript();
    focusMatch();
  }));
}

function renderAiSummary(el, m) {
  const s = m.aiSummary;
  const ready = m.status === 'done' && m.segments.length;
  const providerLabel = PROVIDERS[ai.provider].label;
  let body = '';
  if (!ai.apiKey) {
    body = `<div class="ai-note"><b>Optional.</b> Paste your own OpenAI-compatible or Anthropic API key in Settings to get a written overview, decisions, action items with owners and open questions. Only the transcript text is sent, and only to the provider you pick.</div>
      <button class="btn btn-sm" id="aiSetup" style="margin-top:12px">Open settings</button>`;
  } else {
    body = `<div class="ai-note">Sends the transcript text (not the audio) to <b>${esc(providerLabel)}</b>${ai.baseUrl ? ` at <span class="mono">${esc(ai.baseUrl)}</span>` : ''}.</div>
      <button class="btn btn-sm btn-primary" id="aiRun" style="margin-top:12px" ${ready ? '' : 'disabled'}>${s ? 'Regenerate' : 'Generate AI summary'}</button>`;
  }
  if (s) {
    const list = (items, fmt = (x) => esc(x)) => (items.length ? `<ul class="slist">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>` : '<p class="faint" style="margin:0">None.</p>');
    body = `
      <div class="summary-block"><h3>Overview</h3><p style="margin:0">${esc(s.overview)}</p></div>
      <div class="summary-block"><h3>Decisions</h3>${list(s.decisions)}</div>
      <div class="summary-block"><h3>Action items</h3>${s.actionItems.length ? `<ul class="slist" style="gap:10px">${s.actionItems.map((a) => `<li class="todo" style="padding:0"><span class="box"></span><span>${esc(a.text)}<span class="todo-meta">${a.owner ? `<span class="who">${esc(a.owner)}</span>` : ''}${a.due ? `<span>due ${esc(a.due)}</span>` : ''}</span></span></li>`).join('')}</ul>` : '<p class="faint" style="margin:0">None.</p>'}</div>
      <div class="summary-block"><h3>Open questions</h3>${list(s.openQuestions)}</div>
      <p class="hint" style="margin:0 0 12px">${esc(s.provider || '')} ${esc(s.model || '')}</p>` + body;
  }
  el.innerHTML = body;
  if ($('#aiSetup')) $('#aiSetup').onclick = openSettings;
  if ($('#aiRun'))
    $('#aiRun').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Summarising...';
      try {
        const res = await aiSummary(ai.provider, ai, m.segments, m.title);
        m.aiSummary = res;
        await db.update(m.id, { aiSummary: res });
        renderSummary();
      } catch (err) {
        toast(err.message.includes('Failed to fetch') ? 'Request blocked. Check the key, the base URL and that the API allows browser (CORS) requests.' : err.message, true);
        btn.disabled = false;
        btn.textContent = 'Try again';
      }
    };
}

async function exportAs(kind) {
  const m = state.current;
  if (!m) return;
  const name = slugify(m.title);
  if (kind === 'md') download(`${name}.md`, toMarkdown(m), 'text/markdown');
  else if (kind === 'txt') download(`${name}.txt`, toPlainText(m));
  else if (kind === 'srt') download(`${name}.srt`, toSrt(m.segments), 'application/x-subrip');
  else if (kind === 'copy') {
    try {
      await navigator.clipboard.writeText(toMarkdown(m));
      toast('Copied as Markdown');
    } catch {
      toast('Clipboard is not available here', true);
    }
  } else if (kind === 'share') {
    const md = toMarkdown(m);
    const file = new File([md], `${name}.md`, { type: 'text/markdown' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: m.title });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    download(`${name}.md`, file);
    toast('Saved a shareable .md file');
  }
}

/* ---------- router ---------- */
async function route() {
  const h = location.hash.replace(/^#/, '');
  const mm = h.match(/^\/m\/([\w-]+)/);
  if (mm) await renderMeeting(mm[1]);
  else renderHome();
}

async function init() {
  shell();
  await refreshLibrary();
  // meetings left mid-transcription by a closed tab
  for (const m of state.meetings) {
    if (m.status === 'transcribing') await db.update(m.id, { status: 'error', error: 'Interrupted (the tab was closed or reloaded)' });
  }
  await refreshLibrary();
  window.addEventListener('hashchange', route);
  await route();
}

init().catch((err) => {
  console.error(err);
  document.getElementById('app').innerHTML = `<div style="padding:40px;font-family:monospace">Failed to start: ${esc(err.message)}</div>`;
});
