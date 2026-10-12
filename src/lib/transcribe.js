// Shared transcription driver. Used by the Web Worker in the browser and by
// scripts/e2e-node.mjs in Node, so both exercise the exact same code path.
import { planSegments, TARGET_SAMPLE_RATE } from './audio.js';
import { guessLanguage } from './summary.js';

export const MODELS = {
  tiny: { id: 'onnx-community/whisper-tiny', label: 'Tiny', note: 'fastest, ~40 MB' },
  base: { id: 'onnx-community/whisper-base', label: 'Base', note: 'balanced, ~80 MB' },
  small: { id: 'onnx-community/whisper-small', label: 'Small', note: 'most accurate, ~250 MB' },
};

export const LANGUAGES = { auto: 'Auto-detect', en: 'English', nl: 'Dutch (Nederlands)' };

/** dtype choice per device; WebGPU uses fp32 encoder + q4 decoder, WASM uses q8. */
export function dtypeFor(device) {
  if (device === 'webgpu') return { encoder_model: 'fp32', decoder_model_merged: 'q4' };
  return { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

/**
 * Turn pipeline output into absolute-time segments.
 * @param {{text:string, chunks?:{text:string,timestamp:[number,number|null]}[]}} result
 * @param {number} offsetS offset of this audio piece inside the full recording
 * @param {number} pieceDurationS duration of the piece (to close an open end time)
 */
export function toSegments(result, offsetS = 0, pieceDurationS = null) {
  const chunks = result && Array.isArray(result.chunks) ? result.chunks : [];
  if (!chunks.length) {
    const text = (result && result.text ? result.text : '').trim();
    return text ? [{ start: offsetS, end: offsetS + (pieceDurationS || 0), text }] : [];
  }
  const out = [];
  for (const c of chunks) {
    const text = String(c.text || '').trim();
    if (!text) continue;
    const [s, e] = c.timestamp || [0, null];
    const start = offsetS + (Number(s) || 0);
    let end = e == null || Number.isNaN(Number(e)) ? (pieceDurationS != null ? offsetS + pieceDurationS : start + 2) : offsetS + Number(e);
    if (end < start) end = start;
    out.push({ start: round2(start), end: round2(end), text });
  }
  return out;
}

const round2 = (x) => Math.round(x * 100) / 100;

/** Whisper hallucination filter for silence ("Thank you.", "Ondertiteling..." etc). */
export function isLikelyHallucination(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  if (/^\[(?:music|muziek|blank_audio|silence|stilte)\]$|^\(.*\)$/.test(t)) return true;
  if (/ondertitel(?:d|ing)|amara\.org|subtitles by/.test(t)) return true;
  return false;
}

/**
 * Pick the most likely language from Whisper's first decoder step.
 * @param {ArrayLike<number>} lastLogits logits over the vocabulary for one step
 * @param {Record<string, number>} tokenIds language code -> token id
 * @returns {{language:string, probs:Record<string, number>}}
 */
export function pickLanguage(lastLogits, tokenIds) {
  const entries = Object.entries(tokenIds).filter(([, id]) => id != null);
  const max = Math.max(...entries.map(([, id]) => lastLogits[id]));
  let z = 0;
  const exp = entries.map(([code, id]) => {
    const e = Math.exp(lastLogits[id] - max);
    z += e;
    return [code, e];
  });
  const probs = Object.fromEntries(exp.map(([c, e]) => [c, e / z]));
  const language = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
  return { language, probs };
}

/** Offset (in samples) of the first 0.5 s window with audible signal. */
export function firstSpeechOffset(audio, sr = TARGET_SAMPLE_RATE, threshold = 0.01) {
  const win = Math.round(sr / 2);
  for (let i = 0; i + win <= audio.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += audio[j] * audio[j];
    if (Math.sqrt(e / win) > threshold) return i;
  }
  return 0;
}

/**
 * Detect the spoken language with Whisper itself: run the encoder on up to
 * two 30 s probes and read the language-token logits after
 * <|startoftranscript|>. Restricted to `candidates` (Dutch and English by
 * default) because accented Dutch is otherwise often mistaken for Afrikaans.
 * @param {*} transcriber transformers.js ASR pipeline (needs .model, .processor, .tokenizer)
 * @param {Float32Array} audio 16 kHz mono
 * @param {Function} TensorCtor the transformers.js Tensor class
 */
export async function detectLanguage(transcriber, audio, TensorCtor, candidates = ['en', 'nl']) {
  const { model, processor, tokenizer } = transcriber;
  const t2i = tokenizer.model.tokens_to_ids;
  const sot = t2i.get('<|startoftranscript|>');
  const ids = Object.fromEntries(candidates.map((c) => [c, t2i.get(`<|${c}|>`)]));
  const sr = TARGET_SAMPLE_RATE;
  const probeLen = 30 * sr;
  const starts = [firstSpeechOffset(audio)];
  if (audio.length > 3 * probeLen) starts.push(Math.floor(audio.length / 2));
  const total = Object.fromEntries(candidates.map((c) => [c, 0]));
  for (const st of starts) {
    const { input_features } = await processor(audio.subarray(st, Math.min(audio.length, st + probeLen)));
    const out = await model({ input_features, decoder_input_ids: new TensorCtor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]) });
    const V = out.logits.dims.at(-1);
    const last = out.logits.data.subarray(out.logits.data.length - V);
    const { probs } = pickLanguage(last, ids);
    for (const c of candidates) total[c] += probs[c] / starts.length;
  }
  const language = Object.entries(total).sort((a, b) => b[1] - a[1])[0][0];
  return { language, probs: total };
}

/**
 * Transcribe 16 kHz mono audio with a transformers.js ASR pipeline.
 * Long audio is split into ~2 minute outer segments (cut at quiet points);
 * each is run through the pipeline with 30 s chunks and a 5 s stride.
 * @param {Function} transcriber transformers.js automatic-speech-recognition pipeline
 * @param {Float32Array} audio 16 kHz mono
 * In auto mode the language is detected up front with Whisper (when a Tensor
 * class is supplied) and then pinned for every chunk.
 * @param {{language?:string, segmentS?:number, onSegment?:Function, shouldStop?:Function, Tensor?:Function, onLanguage?:Function}} opts
 */
export async function transcribeAudio(transcriber, audio, { language = 'auto', segmentS = 120, onSegment, shouldStop, Tensor, onLanguage } = {}) {
  const sr = TARGET_SAMPLE_RATE;
  const plan = planSegments(audio.length, { sampleRate: sr, segmentS, samples: audio });
  const all = [];
  let lang = language && language !== 'auto' ? language : null;
  let detection = null;
  if (!lang && Tensor && transcriber.model && transcriber.processor) {
    try {
      detection = await detectLanguage(transcriber, audio, Tensor);
      lang = detection.language;
      if (onLanguage) onLanguage(detection);
    } catch (err) {
      detection = { error: String(err && err.message ? err.message : err) };
    }
  }
  for (let i = 0; i < plan.length; i++) {
    if (shouldStop && shouldStop()) break;
    const { start, end } = plan[i];
    const piece = audio.subarray(start, end);
    const opts = {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      task: 'transcribe',
    };
    if (lang) opts.language = lang;
    const result = await transcriber(piece, opts);
    const segs = toSegments(result, start / sr, (end - start) / sr).filter((s) => !isLikelyHallucination(s.text));
    all.push(...segs);
    // In auto mode, pin the language after the first piece with enough text so
    // later pieces do not flip between Dutch and English.
    if (!lang && language === 'auto') {
      const guess = guessLanguage(all.map((s) => s.text).join(' '));
      if (guess && all.map((s) => s.text).join(' ').split(/\s+/).length > 25) lang = guess;
    }
    if (onSegment) onSegment({ segments: segs, index: i, total: plan.length, language: lang });
  }
  const detected = language !== 'auto' ? language : lang || guessLanguage(all.map((s) => s.text).join(' '));
  return { segments: all, language: detected, detection };
}
