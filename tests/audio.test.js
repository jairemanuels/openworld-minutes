import { describe, it, expect } from 'vitest';
import { mixToMono, resampleLinear, planWindows, planSegments, findQuietPoint, rms } from '../src/lib/audio.js';

describe('mixToMono', () => {
  it('averages channels', () => {
    const out = mixToMono([Float32Array.from([1, 0, -1]), Float32Array.from([0, 0, 1])]);
    expect(Array.from(out)).toEqual([0.5, 0, 0]);
  });
  it('copies a single channel and handles none', () => {
    const a = Float32Array.from([0.1, 0.2]);
    const out = mixToMono([a]);
    expect(out).not.toBe(a);
    expect(Array.from(out)).toEqual(Array.from(a));
    expect(mixToMono([]).length).toBe(0);
  });
});

describe('resampleLinear', () => {
  it('48 kHz to 16 kHz keeps duration', () => {
    const input = new Float32Array(48000);
    expect(resampleLinear(input, 48000, 16000).length).toBe(16000);
  });
  it('44.1 kHz to 16 kHz keeps duration', () => {
    const input = new Float32Array(44100 * 3);
    expect(resampleLinear(input, 44100, 16000).length).toBe(48000);
  });
  it('preserves a low-frequency sine wave', () => {
    const from = 48000;
    const f = 440;
    const input = Float32Array.from({ length: from }, (_, i) => Math.sin((2 * Math.PI * f * i) / from));
    const out = resampleLinear(input, from, 16000);
    // compare with the ideal sine at 16 kHz
    let err = 0;
    for (let i = 10; i < out.length - 10; i++) err = Math.max(err, Math.abs(out[i] - Math.sin((2 * Math.PI * f * (i * 3 + 1)) / from)));
    expect(err).toBeLessThan(0.05);
  });
  it('upsamples with interpolation', () => {
    const out = resampleLinear(Float32Array.from([0, 1]), 8000, 16000);
    expect(out.length).toBe(4);
    expect(out[1]).toBeCloseTo(0.5);
  });
  it('identity when rates match, error on bad rate', () => {
    expect(Array.from(resampleLinear(Float32Array.from([1, 2]), 16000, 16000))).toEqual([1, 2]);
    expect(() => resampleLinear(new Float32Array(1), 0, 16000)).toThrow();
  });
});

describe('planWindows', () => {
  const sr = 16000;
  it('single window for short audio', () => {
    expect(planWindows(10 * sr)).toEqual([{ start: 0, end: 10 * sr }]);
  });
  it('30 s windows advancing by 20 s (5 s stride each side) and covering all audio', () => {
    const total = 60 * 60 * sr; // one hour
    const w = planWindows(total);
    expect(w[0]).toEqual({ start: 0, end: 30 * sr });
    expect(w[1].start).toBe(20 * sr);
    expect(w.at(-1).end).toBe(total);
    for (const x of w) expect(x.end - x.start).toBeLessThanOrEqual(30 * sr);
    expect(w.length).toBe(Math.ceil((total - 30 * sr) / (20 * sr)) + 1);
  });
  it('empty audio and invalid stride', () => {
    expect(planWindows(0)).toEqual([]);
    expect(() => planWindows(100, sr, 10, 5)).toThrow();
  });
});

describe('planSegments', () => {
  const sr = 16000;
  it('is contiguous and covers a 60 minute recording', () => {
    const total = 3600 * sr;
    const segs = planSegments(total, { segmentS: 120 });
    expect(segs.length).toBe(30);
    expect(segs[0].start).toBe(0);
    expect(segs.at(-1).end).toBe(total);
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end);
  });
  it('merges a short tail into the last segment', () => {
    const segs = planSegments(242 * sr, { segmentS: 120, searchS: 4 });
    expect(segs.length).toBe(2);
    expect(segs[1].end).toBe(242 * sr);
  });
  it('moves cuts to silence when samples are given', () => {
    const total = 20 * sr;
    const samples = Float32Array.from({ length: total }, (_, i) => Math.sin(i / 3) * 0.5);
    // silence between 11.0 and 11.5 s
    samples.fill(0, 11 * sr, 11.5 * sr);
    const segs = planSegments(total, { segmentS: 10, searchS: 2, samples });
    const cut = segs[0].end / sr;
    expect(cut).toBeGreaterThanOrEqual(11);
    expect(cut).toBeLessThanOrEqual(11.5);
  });
  it('findQuietPoint finds the silent gap', () => {
    const s = Float32Array.from({ length: 1000 }, () => 0.5);
    s.fill(0, 600, 700);
    const p = findQuietPoint(s, 0, 1000, 50);
    expect(p).toBeGreaterThanOrEqual(600);
    expect(p).toBeLessThanOrEqual(700);
  });
  it('rms', () => {
    expect(rms(Float32Array.from([1, -1, 1, -1]))).toBe(1);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});
