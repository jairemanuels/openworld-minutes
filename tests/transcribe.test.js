import { describe, it, expect } from 'vitest';
import { pickLanguage, firstSpeechOffset, transcribeAudio, dtypeFor } from '../src/lib/transcribe.js';

describe('language detection helpers', () => {
  it('pickLanguage softmaxes over candidate tokens only', () => {
    const logits = new Float32Array(10);
    logits[3] = 20; // en
    logits[7] = 15; // nl
    logits[9] = 99; // some non-candidate token, must be ignored
    const { language, probs } = pickLanguage(logits, { en: 3, nl: 7 });
    expect(language).toBe('en');
    expect(probs.en + probs.nl).toBeCloseTo(1);
    expect(probs.en).toBeGreaterThan(0.99);
  });
  it('firstSpeechOffset skips leading silence', () => {
    const sr = 16000;
    const a = new Float32Array(5 * sr);
    for (let i = 2 * sr; i < a.length; i++) a[i] = Math.sin(i / 5) * 0.3;
    expect(firstSpeechOffset(a, sr)).toBe(2 * sr);
    expect(firstSpeechOffset(new Float32Array(sr), sr)).toBe(0);
  });
  it('dtype per device', () => {
    expect(dtypeFor('webgpu').decoder_model_merged).toBe('q4');
    expect(dtypeFor('wasm').encoder_model).toBe('q8');
  });
});

describe('transcribeAudio driver (mock pipeline)', () => {
  it('splits long audio into parts, offsets timestamps and pins the language', async () => {
    const sr = 16000;
    const audio = new Float32Array(300 * sr).fill(0.1); // 5 minutes
    const calls = [];
    const fake = async (piece, opts) => {
      calls.push({ len: piece.length, opts });
      return { text: 'x', chunks: [{ text: ' We gaan dit doen.', timestamp: [1, 3] }, { text: ' [BLANK_AUDIO]', timestamp: [3, 4] }] };
    };
    const parts = [];
    const res = await transcribeAudio(fake, audio, { language: 'nl', segmentS: 120, onSegment: (p) => parts.push(p.index) });
    expect(calls).toHaveLength(3); // 120 s + 120 s + 60 s
    expect(calls.every((c) => c.opts.chunk_length_s === 30 && c.opts.stride_length_s === 5 && c.opts.language === 'nl' && c.opts.return_timestamps)).toBe(true);
    expect(res.segments).toHaveLength(3); // [BLANK_AUDIO] filtered
    expect(res.segments[1].start).toBeCloseTo(calls[0].len / sr + 1, 1);
    expect(res.segments[2].start).toBeCloseTo((calls[0].len + calls[1].len) / sr + 1, 1);
    expect(calls.reduce((n, c) => n + c.len, 0)).toBe(audio.length);
    expect(parts).toEqual([0, 1, 2]);
    expect(res.language).toBe('nl');
  });
  it('stops early when asked', async () => {
    const audio = new Float32Array(600 * 16000);
    let n = 0;
    const res = await transcribeAudio(async () => ({ text: 'hi', chunks: [{ text: 'hi', timestamp: [0, 1] }] }), audio, {
      language: 'en',
      shouldStop: () => n++ >= 1,
    });
    expect(res.segments).toHaveLength(1);
  });
});
