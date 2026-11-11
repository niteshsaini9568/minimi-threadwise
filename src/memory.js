export const CONTEXT_BUDGET = 80_000;
const DAY = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function validTimezone(value) {
  if (typeof value !== 'string' || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}

export function localDate(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Calendar arithmetic uses a UTC representation of a LOCAL date, never 24-hour DST shifts.
export function dateHints(question, now, timezone) {
  const text = question.toLowerCase();
  const today = localDate(now, timezone);
  const calendar = new Date(`${today}T12:00:00Z`);
  const dates = [];
  const add = (label, date) => dates.push({ phrase: label, date: date.toISOString().slice(0, 10) });
  for (const match of text.matchAll(/\b(today|yesterday)\b/g)) {
    add(match[0], new Date(calendar.getTime() - (match[0] === 'yesterday' ? DAY : 0)));
  }
  for (const match of text.matchAll(/\b(?:(last|this|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const weekday = WEEKDAYS.indexOf(match[2]);
    let offset = (calendar.getUTCDay() - weekday + 7) % 7;
    if (match[1] === 'last' && offset === 0) offset = 7;
    if (match[1] === 'this') {
      // "This" means the weekday in the current ISO week, including a future day.
      offset = ((calendar.getUTCDay() + 6) % 7) - ((weekday + 6) % 7);
    }
    add(match[0], new Date(calendar.getTime() - offset * DAY));
  }
  const addCalendar = (label, year, month, day, explicitYear) => {
    let date = new Date(Date.UTC(year, month, day, 12));
    if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return;
    if (!explicitYear && date > calendar) date = new Date(Date.UTC(year - 1, month, day, 12));
    add(label, date);
  };
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    addCalendar(match[0], Number(match[1]), Number(match[2]) - 1, Number(match[3]), true);
  }
  const monthPattern = MONTHS.map(m => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join('|');
  const pattern = new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})|(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?)(?:,?\\s+(\\d{4}))?\\b`, 'g');
  for (const match of text.matchAll(pattern)) {
    const month = MONTHS.findIndex(m => m.startsWith(match[2] || match[3]));
    addCalendar(match[0], Number(match[5] || calendar.getUTCFullYear()), month, Number(match[1] || match[4]), Boolean(match[5]));
  }
  return dates;
}

export function memoryRecord(turn, timezone) {
  return {
    id: turn.id, thread: turn.thread_title, thread_id: turn.thread_id,
    asked_at: turn.created_at, local_date: localDate(turn.created_at, timezone),
    original_timezone: turn.timezone, answered_at: turn.completed_at,
    question: turn.question, answer: turn.status === 'completed' ? turn.answer : null,
    status: turn.status, imported: turn.evidence?.imported || false,
    sources: turn.evidence?.sources || [],
  };
}

export function makeMemory(history, question, threadId, now, timezone, budget = CONTEXT_BUDGET) {
  const records = history.map(turn => memoryRecord(turn, timezone));
  const hints = dateHints(question, now, timezone);
  const fullSize = JSON.stringify(records).length;
  if (fullSize <= budget) return { records, hints, total: records.length, omitted: 0, needsSelection: false };
  const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
  const dateSet = new Set(hints.map(h => h.date));
  const recent = new Set(records.filter(r => r.thread_id === threadId).slice(-8).map(r => r.id));
  const ranked = records.map((record, index) => {
    const text = `${record.question} ${record.answer}`.toLowerCase();
    const score = (dateSet.has(record.local_date) ? 1000 : 0) + (recent.has(record.id) ? 500 : 0)
      + terms.reduce((sum, term) => sum + (text.includes(term) ? 4 : 0), 0) + index / records.length;
    return { record, score };
  }).sort((a, b) => b.score - a.score);
  // shortcut: bounded candidate index, add semantic retrieval when histories routinely exceed 800 turns.
  const candidates = ranked.slice(0, 800).map(({ record }) => ({
    ...record, answer: record.answer?.slice(0, 500), sources: record.sources.slice(0, 3),
    question: record.question.slice(0, 1200),
  }));
  const pinned = new Set(records.filter(r => recent.has(r.id) || dateSet.has(r.local_date)).map(r => r.id));
  return { records: [], candidates, ranked, recent, pinned, hints, budget, total: records.length, omitted: records.length, needsSelection: true };
}

export function selectedMemory(memory, ids) {
  const selected = new Set(ids);
  const priority = memory.ranked.filter(({ record }) => selected.has(record.id) || memory.pinned.has(record.id));
  let size = 2;
  const records = [];
  for (const { record } of priority) {
    const length = JSON.stringify(record).length + 1;
    if (size + length > memory.budget) continue;
    size += length;
    records.push(record);
  }
  records.sort((a, b) => a.asked_at.localeCompare(b.asked_at));
  return { ...memory, records, omitted: memory.total - records.length };
}
