// Transcription Web Worker: loads Whisper with transformers.js (WebGPU when
// available, otherwise WASM) and transcribes 16 kHz mono audio.
import { pipeline, env, Tensor } from '@huggingface/transformers';
import { transcribeAudio, dtypeFor, MODELS } from './lib/transcribe.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let current = { key: null, pipe: null, device: null };
let stopRequested = false;

async function pickDevice(pref) {
  if (pref === 'wasm') return 'wasm';
  try {
    if (self.navigator && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch {
    /* fall through */
  }
  return 'wasm';
}

async function load(modelKey, devicePref) {
  const model = (MODELS[modelKey] || MODELS.base).id;
  const device = await pickDevice(devicePref);
  const key = `${model}|${device}`;
  if (current.key === key && current.pipe) {
    self.postMessage({ type: 'ready', device: current.device, model, cached: true });
    return current;
  }
  if (current.pipe && current.pipe.dispose) {
    try { await current.pipe.dispose(); } catch { /* ignore */ }
  }
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' || p.status === 'done' || p.status === 'initiate') {
      const f = files.get(p.file) || { loaded: 0, total: 0 };
      if (p.total) f.total = p.total;
      if (p.loaded != null) f.loaded = p.loaded;
      if (p.status === 'done' && f.total) f.loaded = f.total;
      files.set(p.file, f);
      let loaded = 0;
      let total = 0;
      for (const v of files.values()) { loaded += v.loaded; total += v.total; }
      self.postMessage({ type: 'model-progress', file: p.file, loaded, total, status: p.status });
    }
  };
  self.postMessage({ type: 'status', message: `Loading ${model} on ${device.toUpperCase()}` });
  let pipe;
  try {
    pipe = await pipeline('automatic-speech-recognition', model, { device, dtype: dtypeFor(device), progress_callback });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    self.postMessage({ type: 'status', message: 'WebGPU failed, falling back to WASM' });
    pipe = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: dtypeFor('wasm'), progress_callback });
    current = { key: `${model}|wasm`, pipe, device: 'wasm' };
    self.postMessage({ type: 'ready', device: 'wasm', model });
    return current;
  }
  current = { key, pipe, device };
  self.postMessage({ type: 'ready', device, model });
  return current;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load(msg.model, msg.device);
    } else if (msg.type === 'stop') {
      stopRequested = true;
    } else if (msg.type === 'transcribe') {
      stopRequested = false;
      const { pipe, device } = await load(msg.model, msg.device);
      self.postMessage({ type: 'status', message: `Transcribing on ${device.toUpperCase()}` });
      const t0 = performance.now();
      const result = await transcribeAudio(pipe, msg.audio, {
        language: msg.language,
        segmentS: 120,
        Tensor,
        onLanguage: (d) => self.postMessage({ type: 'language', ...d }),
        shouldStop: () => stopRequested,
        onSegment: (p) => self.postMessage({ type: 'segment', ...p }),
      });
      self.postMessage({ type: 'done', ...result, stopped: stopRequested, seconds: (performance.now() - t0) / 1000, device });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
