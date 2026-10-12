import { describe, it, expect } from 'vitest';
import { formatClock, formatSrtTime, toSrt, toMarkdown, toPlainText, normalizeSegments, slugify } from '../src/lib/format.js';
import { toSegments, isLikelyHallucination } from '../src/lib/transcribe.js';

describe('time formatting', () => {
  it('clock', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(75.9)).toBe('01:15');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-3)).toBe('00:00');
  });
  it('srt time', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(3725.5)).toBe('01:02:05,500');
    expect(formatSrtTime(59.9996)).toBe('00:01:00,000');
    expect(formatSrtTime(1.234)).toBe('00:00:01,234');
  });
});

describe('toSrt', () => {
  it('formats numbered cues and fills missing end times', () => {
    const srt = toSrt([
      { start: 0, end: 2.5, text: ' Hello everyone. ' },
      { start: 2.5, end: null, text: 'Welkom allemaal.' },
      { start: 6, end: null, text: 'Last line' },
      { start: 7, end: 8, text: '   ' },
    ]);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:02,500\nHello everyone.\n\n' +
        '2\n00:00:02,500 --> 00:00:06,000\nWelkom allemaal.\n\n' +
        '3\n00:00:06,000 --> 00:00:08,000\nLast line\n',
    );
  });
  it('sorts and clamps', () => {
    const n = normalizeSegments([{ start: 5, end: 1, text: 'b' }, { start: 1, end: 2, text: 'a' }]);
    expect(n.map((s) => s.text)).toEqual(['a', 'b']);
    expect(n[1].end).toBe(5);
  });
});

const meeting = {
  title: 'Weekly sync #3',
  createdAt: new Date(2026, 9, 13, 10, 30).getTime(),
  duration: 125,
  language: 'en',
  segments: [
    { start: 0, end: 4, text: 'Welcome to the weekly sync.' },
    { start: 65, end: 70, text: 'Anna will send the report by Friday.' },
  ],
  summary: {
    overview: [{ text: 'Welcome to the weekly sync.', start: 0 }],
    actionItems: [{ text: 'Anna will send the report by Friday.', owner: 'Anna', due: 'Friday', start: 65 }],
    topics: ['report', 'sync'],
  },
};

describe('toMarkdown', () => {
  it('renders local summary, action items and transcript', () => {
    const md = toMarkdown(meeting);
    expect(md).toContain('# Weekly sync \\#3');
    expect(md).toContain('**Date:** 2026-10-13 10:30');
    expect(md).toContain('**Duration:** 02:05');
    expect(md).toContain('### Action items');
    expect(md).toContain('- [ ] Anna will send the report by Friday. (owner: Anna, due: Friday, at 01:05)');
    expect(md).toContain('### Key topics');
    expect(md).toContain('**[01:05]** Anna will send the report by Friday.');
  });
  it('prefers the AI summary when present', () => {
    const md = toMarkdown({
      ...meeting,
      aiSummary: { overview: 'We synced.', decisions: ['Ship v2'], actionItems: [{ text: 'Send report', owner: 'Anna', due: null }], openQuestions: ['Budget?'] },
    });
    expect(md).toContain('We synced.');
    expect(md).toContain('### Decisions\n\n- Ship v2');
    expect(md).toContain('- [ ] Send report (owner: Anna)');
    expect(md).toContain('### Open questions\n\n- Budget?');
    expect(md).not.toContain('### Key topics');
  });
  it('plain text export', () => {
    const txt = toPlainText(meeting);
    expect(txt.split('\n')[0]).toBe('Weekly sync #3');
    expect(txt).toContain('[01:05] Anna will send the report by Friday.');
  });
  it('slugify', () => {
    expect(slugify('Overleg met Jaïr: Q4 / planning!')).toBe('overleg-met-jair-q4-planning');
    expect(slugify('')).toBe('meeting');
  });
});

describe('pipeline output mapping', () => {
  it('offsets chunk timestamps and closes open ends', () => {
    const segs = toSegments(
      { text: 'x', chunks: [{ text: ' Hi.', timestamp: [0, 1.5] }, { text: ' There', timestamp: [1.5, null] }] },
      120,
      30,
    );
    expect(segs).toEqual([
      { start: 120, end: 121.5, text: 'Hi.' },
      { start: 121.5, end: 150, text: 'There' },
    ]);
  });
  it('falls back to full text without chunks', () => {
    expect(toSegments({ text: ' Hello ' }, 10, 5)).toEqual([{ start: 10, end: 15, text: 'Hello' }]);
    expect(toSegments({ text: '' }, 0, 5)).toEqual([]);
  });
  it('filters common silence hallucinations', () => {
    expect(isLikelyHallucination('[BLANK_AUDIO]')).toBe(true);
    expect(isLikelyHallucination('Ondertiteld door de Amara.org gemeenschap')).toBe(true);
    expect(isLikelyHallucination('We gaan dit vrijdag afronden.')).toBe(false);
  });
});
