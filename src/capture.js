// Browser-only audio capture and decoding.
import { mixToMono, resampleLinear, rms, TARGET_SAMPLE_RATE } from './lib/audio.js';

export function pickMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder === 'undefined') return '';
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * Recorder that captures the microphone and, optionally, tab/system audio via
 * getDisplayMedia. Both are mixed into a single track with Web Audio.
 */
export class Recorder {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel;
    this.chunks = [];
    this.streams = [];
    this.raf = 0;
  }

  async start({ includeSystem = false } = {}) {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const dest = ctx.createMediaStreamDestination();
    this.analysers = {};

    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.streams.push(mic);
    this.attach(mic, dest, 'mic');

    if (includeSystem) {
      let display;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include', selfBrowserSurface: 'exclude' });
      } catch (err) {
        this.cleanup();
        throw new Error('Screen/tab sharing was cancelled. Pick a tab and tick "Share tab audio" to capture a call.');
      }
      this.streams.push(display);
      if (display.getAudioTracks().length === 0) {
        this.cleanup();
        throw new Error('The shared source has no audio. Share a browser tab (or your entire screen on Windows/ChromeOS) and enable audio sharing.');
      }
      this.attach(new MediaStream(display.getAudioTracks()), dest, 'system');
      // if the user stops sharing from the browser UI, keep recording the mic
      display.getVideoTracks().forEach((t) => (t.onended = () => {}));
    }

    const mimeType = pickMimeType();
    this.mimeType = mimeType || 'audio/webm';
    this.media = new MediaRecorder(dest.stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
    this.chunks = [];
    this.media.ondataavailable = (e) => e.data && e.data.size && this.chunks.push(e.data);
    this.media.start(1000);
    this.startedAt = performance.now();
    this.pausedMs = 0;
    this.loop();
  }

  attach(stream, dest, name) {
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    src.connect(dest);
    this.analysers[name] = { an, buf: new Float32Array(an.fftSize) };
  }

  loop() {
    const tick = () => {
      const levels = {};
      for (const [k, { an, buf }] of Object.entries(this.analysers)) {
        an.getFloatTimeDomainData(buf);
        levels[k] = Math.min(1, rms(buf) * 4);
      }
      if (this.onLevel) this.onLevel(levels, this.elapsed());
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  elapsed() {
    if (!this.startedAt) return 0;
    const pausedNow = this.pausedAt ? performance.now() - this.pausedAt : 0;
    return (performance.now() - this.startedAt - this.pausedMs - pausedNow) / 1000;
  }

  pause() {
    if (this.media && this.media.state === 'recording') {
      this.media.pause();
      this.pausedAt = performance.now();
    }
  }

  resume() {
    if (this.media && this.media.state === 'paused') {
      this.media.resume();
      this.pausedMs += performance.now() - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  stop() {
    return new Promise((resolve) => {
      const duration = this.elapsed();
      if (!this.media || this.media.state === 'inactive') {
        this.cleanup();
        resolve(null);
        return;
      }
      this.media.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.cleanup();
        resolve({ blob, duration });
      };
      this.media.stop();
    });
  }

  cleanup() {
    cancelAnimationFrame(this.raf);
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop());
    this.streams = [];
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
  }
}

/**
 * Decode any browser-supported audio/video blob to 16 kHz mono Float32Array.
 * Decodes at 16 kHz directly when the browser allows it (saves memory on long
 * recordings), then mixes down and resamples in JS if needed.
 */
export async function decodeTo16kMono(blob) {
  const buf = await blob.arrayBuffer();
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    ctx = new AudioContext();
  }
  try {
    const audio = await ctx.decodeAudioData(buf);
    const channels = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
    const mono = mixToMono(channels);
    const out = audio.sampleRate === TARGET_SAMPLE_RATE ? mono : resampleLinear(mono, audio.sampleRate, TARGET_SAMPLE_RATE);
    return { samples: out, duration: audio.duration };
  } catch (err) {
    throw new Error(`Could not decode this file (${err && err.message ? err.message : 'unsupported format'}). Try mp3, m4a, wav, webm or mp4.`);
  } finally {
    ctx.close();
  }
}
