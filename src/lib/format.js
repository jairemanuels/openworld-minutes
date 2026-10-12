// Formatting and export helpers (pure).

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** 75.4 -> "01:15", 3725 -> "1:02:05" */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** 3725.5 -> "01:02:05,500" */
export function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * Normalise segments: trim text, drop empties, fill missing end times with the
 * next start (or start + 2 s), and guarantee end >= start.
 */
export function normalizeSegments(segments) {
  const clean = (segments || [])
    .map((s) => ({ start: Number(s.start) || 0, end: s.end == null ? null : Number(s.end), text: String(s.text || '').trim() }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < clean.length; i++) {
    const next = clean[i + 1];
    if (clean[i].end == null || Number.isNaN(clean[i].end)) clean[i].end = next ? next.start : clean[i].start + 2;
    if (clean[i].end < clean[i].start) clean[i].end = clean[i].start;
  }
  return clean;
}

export function toSrt(segments) {
  return normalizeSegments(segments)
    .map((s, i) => `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text}\n`)
    .join('\n');
}

export function toPlainText(meeting, { timestamps = true } = {}) {
  const lines = [];
  lines.push(meeting.title || 'Untitled meeting');
  lines.push(`${formatDate(meeting.createdAt)}  |  ${formatClock(meeting.duration || 0)}`);
  lines.push('');
  for (const s of normalizeSegments(meeting.segments)) {
    lines.push(timestamps ? `[${formatClock(s.start)}] ${s.text}` : s.text);
  }
  return lines.join('\n') + '\n';
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const mdEscape = (s) => String(s).replace(/([\\`*_[\]#|])/g, '\\$1');

/**
 * Render a meeting as Markdown. Uses the AI summary when present, otherwise
 * the local summary.
 */
export function toMarkdown(meeting) {
  const out = [];
  out.push(`# ${mdEscape(meeting.title || 'Untitled meeting')}`);
  out.push('');
  const meta = [`**Date:** ${formatDate(meeting.createdAt)}`, `**Duration:** ${formatClock(meeting.duration || 0)}`];
  if (meeting.language) meta.push(`**Language:** ${meeting.language}`);
  out.push(meta.join('  \n'));
  out.push('');

  const ai = meeting.aiSummary;
  const local = meeting.summary;
  if (ai) {
    out.push('## Summary');
    out.push('');
    if (ai.overview) out.push(ai.overview, '');
    section(out, 'Decisions', ai.decisions, (d) => d);
    section(out, 'Action items', ai.actionItems, (a) => checkbox(a));
    section(out, 'Open questions', ai.openQuestions, (q) => q);
  } else if (local) {
    out.push('## Summary');
    out.push('');
    if (local.overview && local.overview.length) {
      for (const s of local.overview) out.push(`- ${s.text}`);
      out.push('');
    }
    section(out, 'Action items', local.actionItems, (a) => checkbox(a));
    if (local.topics && local.topics.length) {
      out.push('### Key topics', '', local.topics.join(', '), '');
    }
  }

  out.push('## Transcript');
  out.push('');
  for (const s of normalizeSegments(meeting.segments)) {
    out.push(`**[${formatClock(s.start)}]** ${s.text}  `);
  }
  out.push('');
  out.push('---');
  out.push('_Transcribed locally with openworld minutes._');
  return out.join('\n') + '\n';
}

function checkbox(a) {
  if (typeof a === 'string') return `[ ] ${a}`;
  const bits = [a.text || a.task || ''];
  const extra = [];
  if (a.owner) extra.push(`owner: ${a.owner}`);
  if (a.due) extra.push(`due: ${a.due}`);
  if (a.start != null) extra.push(`at ${formatClock(a.start)}`);
  return `[ ] ${bits.join('')}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

function section(out, title, items, fmt) {
  if (!items || !items.length) return;
  out.push(`### ${title}`, '');
  for (const it of items) out.push(`- ${fmt(it)}`);
  out.push('');
}

/** Safe filename from a title. */
export function slugify(title) {
  const s = String(title || 'meeting')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'meeting';
}
