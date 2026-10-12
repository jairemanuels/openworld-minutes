// Local, no-key summarisation: extractive summary, action items (NL + EN),
// key topics and a lightweight language guess. Pure functions only.

const STOP_EN = `a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't
cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd
he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't
my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such
than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up
very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would
wouldn't you you'd you'll you're you've your yours yourself yourselves yeah yes okay ok oh um uh like just really right well so also get got going go
know think mean thing things kind sort lot gonna want actually maybe sure good great one two will can need now see say said let make way time much`;

const STOP_NL = `de het een en van ik je jij u hij zij ze wij we jullie die dat dit deze in op aan met voor naar om te bij uit over door tot als maar of dan
ook nog wel niet geen er hier daar wat wie waar hoe waarom wanneer is zijn was waren ben bent heb hebt heeft hebben had hadden wordt worden werd
werden zal zullen zou zouden kan kunnen kon konden moet moeten moest mag mogen wil willen ga gaat gaan ging doe doet doen deed al alle alles veel meer
meest heel erg zo nu toen dus want omdat even eens toch ja nee oké ok eh uh hm gewoon eigenlijk echt beetje iets niets iemand niemand mijn mijnzelf jouw
zijn haar ons onze hun hen mij me jou zich zelf naar na tegen zonder onder boven tussen achter ver denk weet zeggen zegt zei goed mooi kijken keer dingen
ding soort manier tijd`;

export const STOPWORDS = new Set(`${STOP_EN} ${STOP_NL}`.toLowerCase().split(/\s+/).filter(Boolean));

const NL_MARKERS = new Set('de het een en van ik je niet dat die is op te zijn met voor maar ook wel er nog wat we gaan hebben moeten wordt deze dit naar bij'.split(' '));
const EN_MARKERS = new Set('the and of to is that it you for on with are this be have not but we they was will what can at from about would there'.split(' '));

/** Returns 'nl', 'en' or null based on stopword frequencies. */
export function guessLanguage(text) {
  const words = tokenize(text);
  if (words.length < 3) return null;
  let nl = 0;
  let en = 0;
  for (const w of words) {
    if (NL_MARKERS.has(w)) nl++;
    if (EN_MARKERS.has(w)) en++;
  }
  if (nl === en) return null;
  return nl > en ? 'nl' : 'en';
}

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .match(/[\p{L}\p{N}']+/gu) || [];
}

/**
 * Join timestamped segments and split into sentences, keeping the start time
 * of the segment in which each sentence begins.
 * @returns {{text:string,start:number}[]}
 */
export function toSentences(segments) {
  const out = [];
  let buf = '';
  let bufStart = null;
  for (const seg of segments || []) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    // split keeping terminators
    const parts = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [text];
    for (const p of parts) {
      const piece = p.trim();
      if (!piece) continue;
      if (bufStart == null) bufStart = seg.start ?? 0;
      buf = buf ? `${buf} ${piece}` : piece;
      if (/[.!?]["')\]]*$/.test(piece) || buf.length > 400) {
        out.push({ text: buf, start: bufStart });
        buf = '';
        bufStart = null;
      }
    }
  }
  if (buf) out.push({ text: buf, start: bufStart ?? 0 });
  return out;
}

const WEEKDAYS = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)';

const ACTION_PATTERNS = [
  // English
  /\baction items?\b/i,
  /\bto-?do\b/i,
  /\bfollow[- ]up\b/i,
  /\bdeadline\b/i,
  /\b(?:i|we|you|he|she|they)(?:'ll| will| shall)\b/i,
  /\b(?:i|we)(?:'m| am|'re| are) going to\b/i,
  /\b(?:i|we|you|they) (?:need|have|has) to\b/i,
  /\blet'?s\b(?! see| say| be| just| hope)/i,
  /\b(?:can|could|would) you (?:please )?\w+/i,
  /\b(?:please|make sure|assign(?:ed)? to|take care of|responsible for|owner)\b/i,
  /\b[A-Z][a-z]+ (?:will|is going to|is responsible|takes care|to send|to prepare)\b/,
  // Dutch
  /\bactie(?:punt(?:en)?)?\b/i,
  /\bwe gaan\b/i,
  /\bik (?:ga|zal|pak|regel|stuur|zorg|neem)\b/i,
  /\b(?:we|wij|jullie|jij|je|hij|zij) (?:zullen|zal|moet|moeten|gaat|pakt|pakken|regelt|stuurt)\b/i,
  /\b(?:zal ik|kun jij|kan jij|kun je|kan je|wil je|wil jij|kunnen jullie)\b/i,
  /\b(?:afspraak is|afgesproken|oppakken|uitzoeken|regelen|opvolgen|zorgen dat|zorg dat|nabellen|terugkoppelen)\b/i,
  /\buiterlijk\b/i,
  /\b[A-Z][a-z]+ (?:gaat|zal|pakt|regelt|stuurt|zorgt)\b/,
];

const DUE_PATTERNS = [
  new RegExp(`\\b(?:by|before|on|until|due|next) (?:this |next )?${WEEKDAYS}\\b`, 'i'),
  new RegExp(`\\b(?:voor|vóór|op|uiterlijk|tot|komende|volgende|aanstaande) (?:a\\.s\\. )?${WEEKDAYS}\\b`, 'i'),
  /\b(?:by|before) (?:tomorrow|tonight|end of (?:the )?(?:day|week|month|quarter)|eod|eow|next week|next month)\b/i,
  /\b(?:voor|vóór|uiterlijk) (?:morgen|vanavond|het eind(?:e)? van (?:de )?(?:dag|week|maand)|volgende week|volgende maand)\b/i,
  /\b(?:tomorrow|next week|next month|morgen|overmorgen|volgende week|volgende maand)\b/i,
  /\b(?:by|before|voor|uiterlijk) \d{1,2}(?:[\/\-.]\d{1,2})?(?: (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mrt|mei|okt)\w*)?\b/i,
];

const PRONOUN_OWNER = {
  i: 'me', ik: 'me', we: 'team', wij: 'team', you: 'you', jij: 'you', je: 'you', jullie: 'you all', they: 'them', zij: 'them',
};

const NOT_NAMES = new Set(['I', 'We', 'You', 'They', 'He', 'She', 'It', 'Ik', 'Wij', 'We', 'Jij', 'Je', 'Hij', 'Zij', 'Ze', 'Dat', 'Dit', 'Die', 'Het', 'De', 'Een', 'The', 'That', 'This', 'There', 'Er', 'Dan', 'Then', 'So', 'Dus', 'And', 'En', 'Maar', 'But', 'Ok', 'Okay', 'Oké', 'Yes', 'Ja', 'Nee', 'No', 'Action', 'Actie', 'Actiepunt', 'Deadline', 'Please', 'Let']);

export function detectOwner(sentence) {
  const name = sentence.match(/\b([A-Z][a-zà-ÿ]+)(?:,)? (?:will|is going to|takes|is responsible|to send|to prepare|gaat|zal|pakt|regelt|stuurt|zorgt|neemt)\b/);
  if (name && !NOT_NAMES.has(name[1])) return name[1];
  const ask = sentence.match(/\b(?:can|could|would) you,? ([A-Z][a-z]+)\b|\b([A-Z][a-z]+), (?:can|could|would|kun|kan|wil) (?:you|je|jij)\b/);
  if (ask) return ask[1] || ask[2];
  const assigned = sentence.match(/\b(?:assigned to|owner:?|voor|door) ([A-Z][a-z]+)\b/);
  if (assigned && !NOT_NAMES.has(assigned[1])) return assigned[1];
  const pron = sentence.toLowerCase().match(/\b(ik|i|we|wij|jullie|jij|you|they)\b(?:'ll| will| zal| zullen| ga| gaan| am| are|'m|'re| need| moet| moeten| pak| regel| stuur| zorg)/);
  if (pron) return PRONOUN_OWNER[pron[1]] || null;
  return null;
}

export function detectDue(sentence) {
  for (const re of DUE_PATTERNS) {
    const m = sentence.match(re);
    if (m) return m[0].replace(/^(?:by|before|on|until|due|voor|vóór|op|uiterlijk|tot) /i, '').trim();
  }
  return null;
}

export function isActionSentence(sentence) {
  const s = String(sentence || '').trim();
  if (s.length < 8) return false;
  if (/\?\s*$/.test(s) && !/\b(?:can|could|would) you\b|\b(?:kun|kan|wil) (?:je|jij)\b|\bzal ik\b/i.test(s)) return false;
  return ACTION_PATTERNS.some((re) => re.test(s));
}

/**
 * Extract action items from timestamped segments (or a plain string).
 * @returns {{text:string,owner:string|null,due:string|null,start:number}[]}
 */
export function extractActionItems(input) {
  const segments = typeof input === 'string' ? [{ start: 0, text: input }] : input;
  const items = [];
  const seen = new Set();
  for (const s of toSentences(segments)) {
    if (!isActionSentence(s.text)) continue;
    const key = s.text.toLowerCase().replace(/\W+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ text: s.text, owner: detectOwner(s.text), due: detectDue(s.text), start: s.start });
  }
  return items;
}

function contentWords(text) {
  return tokenize(text).filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/** Top keywords and two-word phrases. */
export function extractTopics(segments, n = 8) {
  const text = (segments || []).map((s) => s.text).join(' ');
  const words = contentWords(text);
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  // bigrams over the raw token stream, both words must be content words
  const toks = tokenize(text);
  const bi = new Map();
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i];
    const b = toks[i + 1];
    if (a.length > 2 && b.length > 2 && !STOPWORDS.has(a) && !STOPWORDS.has(b)) {
      const k = `${a} ${b}`;
      bi.set(k, (bi.get(k) || 0) + 1);
    }
  }
  const phrases = [...bi.entries()].filter(([, c]) => c >= 2).sort((x, y) => y[1] - x[1]).slice(0, Math.ceil(n / 2));
  const used = new Set(phrases.flatMap(([k]) => k.split(' ')));
  const singles = [...freq.entries()]
    .filter(([w, c]) => c >= 2 && !used.has(w))
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const result = [...phrases.map(([k]) => k), ...singles.map(([w]) => w)].slice(0, n);
  if (result.length === 0) {
    return [...freq.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([w]) => w);
  }
  return result;
}

/**
 * Extractive summary: score sentences by normalised content-word frequency,
 * return the top `n` in chronological order.
 */
export function extractiveSummary(segments, n = 5) {
  const sentences = toSentences(segments).filter((s) => tokenize(s.text).length >= 4);
  if (sentences.length <= n) return sentences;
  const freq = new Map();
  for (const s of sentences) for (const w of contentWords(s.text)) freq.set(w, (freq.get(w) || 0) + 1);
  const max = Math.max(1, ...freq.values());
  const scored = sentences.map((s, idx) => {
    const words = contentWords(s.text);
    const len = tokenize(s.text).length;
    let score = 0;
    for (const w of words) score += (freq.get(w) || 0) / max;
    score = score / Math.sqrt(Math.max(len, 1));
    if (len > 60) score *= 0.7; // very long run-ons are less readable
    return { ...s, idx, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .sort((a, b) => a.idx - b.idx)
    .map(({ text, start }) => ({ text, start }));
}

export function localSummary(segments, { sentences } = {}) {
  const total = toSentences(segments).length;
  const n = sentences || Math.min(8, Math.max(3, Math.round(total / 12)));
  return {
    kind: 'local',
    overview: extractiveSummary(segments, n),
    actionItems: extractActionItems(segments),
    topics: extractTopics(segments),
    language: guessLanguage((segments || []).map((s) => s.text).join(' ')),
  };
}
