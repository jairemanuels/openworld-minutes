// Optional AI summary with the user's own key. The key lives in localStorage
// only and is sent exclusively to the endpoint the user picked.
import { normalizeSegments, formatClock } from './format.js';

export const PROVIDERS = {
  openai: { label: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5' },
};

const SYSTEM = `You are a precise meeting-notes assistant. You receive a timestamped meeting transcript (Dutch or English).
Reply with ONLY a JSON object, no prose, no code fence, with this shape:
{"overview": string, "decisions": string[], "actionItems": [{"task": string, "owner": string|null, "due": string|null}], "openQuestions": string[]}
Write in the language of the transcript. Be concise and factual; do not invent owners or dates that are not in the transcript.`;

/** Transcript text for prompts, trimmed to a character budget (keeps head and tail). */
export function transcriptForPrompt(segments, maxChars = 120000) {
  const text = normalizeSegments(segments).map((s) => `[${formatClock(s.start)}] ${s.text}`).join('\n');
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[... transcript shortened ...]\n${text.slice(-half)}`;
}

export function buildRequest(provider, { apiKey, baseUrl, model }, segments, title = '') {
  const user = `Meeting title: ${title || 'Untitled'}\n\nTranscript:\n${transcriptForPrompt(segments)}`;
  const base = String(baseUrl || PROVIDERS[provider].baseUrl).replace(/\/+$/, '');
  const m = model || PROVIDERS[provider].model;
  if (provider === 'anthropic') {
    return {
      url: `${base}/messages`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: m, max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
      },
    };
  }
  return {
    url: `${base}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: m,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    },
  };
}

/** Pull the first JSON object out of a model reply and normalise it. */
export function parseSummary(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last <= first) throw new Error('The model did not return JSON');
  const obj = JSON.parse(raw.slice(first, last + 1));
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
  return {
    kind: 'ai',
    overview: String(obj.overview || ''),
    decisions: arr(obj.decisions),
    actionItems: (Array.isArray(obj.actionItems) ? obj.actionItems : []).map((a) =>
      typeof a === 'string' ? { text: a, owner: null, due: null } : { text: String(a.task || a.text || ''), owner: a.owner || null, due: a.due || null },
    ),
    openQuestions: arr(obj.openQuestions),
  };
}

export async function aiSummary(provider, settings, segments, title, fetchImpl = fetch) {
  if (!settings.apiKey) throw new Error('Add an API key first');
  const { url, init } = buildRequest(provider, settings, segments, title);
  const res = await fetchImpl(url, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`API error ${res.status}: ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  const text = provider === 'anthropic' ? (json.content || []).map((c) => c.text || '').join('') : json.choices?.[0]?.message?.content;
  const summary = parseSummary(text);
  summary.model = settings.model || PROVIDERS[provider].model;
  summary.provider = provider;
  return summary;
}
