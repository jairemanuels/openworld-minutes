// End-to-end check in Node: real audio file -> same decode helpers (mixdown +
// resample) -> same chunked transcription driver the browser worker uses ->
// local summary + exports.
//
// usage: node scripts/e2e-node.mjs <audio file> [model=base] [language=auto] [segmentS=45]
import { execFileSync } from 'node:child_process';
import { pipeline, env, Tensor } from '@huggingface/transformers';
import { mixToMono, resampleLinear, planWindows, planSegments } from '../src/lib/audio.js';
import { transcribeAudio, MODELS, dtypeFor } from '../src/lib/transcribe.js';
import { localSummary } from '../src/lib/summary.js';
import { toSrt, toMarkdown, normalizeSegments } from '../src/lib/format.js';

const [file, modelKey = 'base', language = 'auto', segArg = '45'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/e2e-node.mjs <audio file> [tiny|base|small] [auto|en|nl] [segmentS]');
  process.exit(2);
}
env.allowLocalModels = false;

// Decode to 44.1 kHz stereo PCM with ffmpeg so our own mixdown + resampler do real work.
const SRC_RATE = 44100;
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', String(SRC_RATE), '-'], { maxBuffer: 1 << 30 });
const interleaved = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const L = new Float32Array(interleaved.length / 2);
const R = new Float32Array(interleaved.length / 2);
for (let i = 0; i < L.length; i++) {
  L[i] = interleaved[2 * i];
  R[i] = interleaved[2 * i + 1];
}
const audio = resampleLinear(mixToMono([L, R]), SRC_RATE, 16000);
const durationS = audio.length / 16000;
const segmentS = Number(segArg);
console.log(`audio: ${durationS.toFixed(1)} s, ${audio.length} samples @16k`);
console.log(`plan: ${planSegments(audio.length, { segmentS, samples: audio }).length} outer segments, ${planWindows(audio.length).length} whisper windows (30 s / 5 s stride)`);

const model = MODELS[modelKey].id;
const t0 = Date.now();
const asr = await pipeline('automatic-speech-recognition', model, { device: 'cpu', dtype: dtypeFor('wasm') });
console.log(`model ${model} loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const t1 = Date.now();
const res = await transcribeAudio(asr, audio, {
  language,
  segmentS,
  Tensor,
  onLanguage: (d) => console.log(`detected language: ${d.language} (${Object.entries(d.probs).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(', ')})`),
  onSegment: ({ index, total, segments }) => console.log(`  part ${index + 1}/${total}: ${segments.length} segments`),
});
const secs = (Date.now() - t1) / 1000;
const segments = normalizeSegments(res.segments);
console.log(`transcribed in ${secs.toFixed(1)} s (RTF ${(secs / durationS).toFixed(2)}), language=${res.language}`);
console.log('--- transcript ---');
for (const s of segments) console.log(`[${s.start.toFixed(2)} - ${s.end.toFixed(2)}] ${s.text}`);

const summary = localSummary(segments);
console.log('--- action items ---');
for (const a of summary.actionItems) console.log(`- ${a.text} (owner: ${a.owner ?? '-'}, due: ${a.due ?? '-'})`);
console.log('--- topics ---');
console.log(summary.topics.join(', '));
console.log('--- srt (first cues) ---');
console.log(toSrt(segments).split('\n\n').slice(0, 2).join('\n\n'));
const md = toMarkdown({ title: 'E2E test', createdAt: Date.now(), duration: durationS, language: res.language, segments, summary });
console.log(`--- markdown: ${md.length} chars ---`);

const words = segments.map((s) => s.text).join(' ').split(/\s+/).filter(Boolean).length;
if (words < 10) {
  console.error('FAIL: too few words transcribed');
  process.exit(1);
}
console.log(`OK: ${words} words, ${segments.length} timestamped segments`);
