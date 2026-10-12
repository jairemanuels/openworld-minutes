import { describe, it, expect } from 'vitest';
import { extractActionItems, isActionSentence, detectOwner, detectDue, extractTopics, extractiveSummary, localSummary, guessLanguage, toSentences } from '../src/lib/summary.js';
import { parseSummary, buildRequest, transcriptForPrompt } from '../src/lib/ai.js';

describe('action items: English', () => {
  const yes = [
    "I'll send the slides after the call.",
    'Action item: update the onboarding docs.',
    'Mark will prepare the budget by Friday.',
    'We need to finalize the contract before next week.',
    'Can you share the recording with the team?',
    "Let's schedule a follow-up with legal.",
    'The deadline for the proposal is the 20th.',
    "We're going to migrate the database tomorrow.",
  ];
  const no = ['The weather was nice yesterday.', 'That is an interesting point.', 'Revenue grew twelve percent last quarter.', 'What do you think about the design?'];
  it.each(yes)('detects: %s', (s) => expect(isActionSentence(s)).toBe(true));
  it.each(no)('ignores: %s', (s) => expect(isActionSentence(s)).toBe(false));

  it('extracts owner and due date', () => {
    const items = extractActionItems([
      { start: 0, text: 'Thanks for joining.' },
      { start: 12, text: 'Mark will prepare the budget by Friday.' },
      { start: 30, text: "I'll send the slides tomorrow." },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ owner: 'Mark', due: 'Friday', start: 12 });
    expect(items[1]).toMatchObject({ owner: 'me', due: 'tomorrow', start: 30 });
  });
});

describe('action items: Dutch', () => {
  const yes = [
    'Ik zal de offerte morgen versturen.',
    'We gaan de website volgende week live zetten.',
    'Actiepunt: de planning bijwerken.',
    'Pieter gaat de klant nabellen.',
    'De deadline is uiterlijk vrijdag.',
    'Kun jij de notulen rondsturen?',
    'Jullie moeten het contract nog tekenen.',
    'Ik pak de facturen op.',
  ];
  const no = ['Het was een lange dag.', 'Dat vind ik een goed idee.', 'De omzet is gestegen in het derde kwartaal.', 'Wat vinden jullie van het ontwerp?'];
  it.each(yes)('detects: %s', (s) => expect(isActionSentence(s)).toBe(true));
  it.each(no)('ignores: %s', (s) => expect(isActionSentence(s)).toBe(false));

  it('extracts owner and due date', () => {
    const items = extractActionItems('Goedemorgen allemaal. Pieter gaat de klant voor vrijdag nabellen. Ik zal de offerte morgen versturen. We sluiten af.');
    expect(items.map((i) => i.owner)).toEqual(['Pieter', 'me']);
    expect(items[0].due).toBe('vrijdag');
    expect(items[1].due).toBe('morgen');
  });
  it('detectOwner and detectDue edge cases', () => {
    expect(detectOwner('We gaan dit oppakken.')).toBe('team');
    expect(detectOwner('Can you, Sarah, check the numbers?')).toBe(null);
    expect(detectOwner('Sarah, can you check the numbers?')).toBe('Sarah');
    expect(detectDue('Send it before end of the week.')).toBe('end of the week');
    expect(detectDue('Lever het uiterlijk 15 oktober aan.')).toBe('15 oktober');
    expect(detectDue('No date here.')).toBe(null);
  });
  it('deduplicates repeated items', () => {
    expect(extractActionItems('Ik zal het sturen. Ik zal het sturen.')).toHaveLength(1);
  });
});

describe('summary', () => {
  const segments = [
    { start: 0, text: 'Welcome everyone to the product planning meeting.' },
    { start: 5, text: 'Today we discuss the mobile app launch and the pricing page.' },
    { start: 12, text: 'The mobile app launch is planned for November.' },
    { start: 20, text: 'Um, yeah, okay.' },
    { start: 22, text: 'Pricing page experiments showed the annual plan converts better.' },
    { start: 30, text: 'The mobile app launch needs marketing support and a pricing page update.' },
    { start: 38, text: 'Sarah will write the launch announcement by Friday.' },
    { start: 45, text: 'Thanks all, see you next week.' },
  ];
  it('picks informative sentences in order', () => {
    const top = extractiveSummary(segments, 3);
    expect(top).toHaveLength(3);
    const starts = top.map((t) => t.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(top.some((t) => /mobile app launch/.test(t.text))).toBe(true);
    expect(top.some((t) => /Um, yeah/.test(t.text))).toBe(false);
  });
  it('finds key topics including phrases', () => {
    const topics = extractTopics(segments);
    expect(topics).toContain('mobile app');
    expect(topics.some((t) => t.includes('pricing'))).toBe(true);
    expect(topics).not.toContain('the');
  });
  it('localSummary bundles everything', () => {
    const s = localSummary(segments);
    expect(s.kind).toBe('local');
    expect(s.actionItems[0]).toMatchObject({ owner: 'Sarah', due: 'Friday' });
    expect(s.language).toBe('en');
  });
  it('sentences keep segment start times across segment breaks', () => {
    const s = toSentences([{ start: 0, text: 'First part of a' }, { start: 3, text: 'sentence. Second one.' }]);
    expect(s).toEqual([
      { text: 'First part of a sentence.', start: 0 },
      { text: 'Second one.', start: 3 },
    ]);
  });
  it('guesses language', () => {
    expect(guessLanguage('We gaan de planning voor het project morgen bespreken met het team.')).toBe('nl');
    expect(guessLanguage('We will discuss the planning for the project with the team tomorrow.')).toBe('en');
    expect(guessLanguage('ok')).toBe(null);
  });
});

describe('AI summary helpers', () => {
  it('parses fenced JSON and normalises fields', () => {
    const s = parseSummary('```json\n{"overview":"Kort overleg.","decisions":["Live op 1 nov"],"actionItems":[{"task":"Offerte sturen","owner":"Pieter","due":"vrijdag"},"Notulen delen"],"openQuestions":[]}\n```');
    expect(s.overview).toBe('Kort overleg.');
    expect(s.actionItems).toEqual([
      { text: 'Offerte sturen', owner: 'Pieter', due: 'vrijdag' },
      { text: 'Notulen delen', owner: null, due: null },
    ]);
    expect(() => parseSummary('no json here')).toThrow();
  });
  it('builds provider requests with the key only in headers for that provider', () => {
    const segs = [{ start: 0, end: 1, text: 'Hallo' }];
    const a = buildRequest('anthropic', { apiKey: 'k1' }, segs, 'T');
    expect(a.url).toBe('https://api.anthropic.com/v1/messages');
    expect(a.init.headers['x-api-key']).toBe('k1');
    expect(a.init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const o = buildRequest('openai', { apiKey: 'k2', baseUrl: 'http://localhost:11434/v1/', model: 'llama3' }, segs, 'T');
    expect(o.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(o.init.headers.authorization).toBe('Bearer k2');
    expect(JSON.parse(o.init.body).model).toBe('llama3');
    expect(o.init.body).not.toContain('k2');
  });
  it('shortens very long transcripts', () => {
    const segs = Array.from({ length: 5000 }, (_, i) => ({ start: i, end: i + 1, text: 'word '.repeat(10) }));
    const t = transcriptForPrompt(segs, 10000);
    expect(t.length).toBeLessThan(10100);
    expect(t).toContain('[... transcript shortened ...]');
  });
});
