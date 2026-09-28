/**
 * Даты: сервер хранит и отдаёт UTC (ISO 8601), редактор вводит время в своём часовом поясе
 * через <input type="datetime-local"> / <input type="date">.
 */

const pad = (n: number) => String(n).padStart(2, '0');

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ISO → значение datetime-local (YYYY-MM-DDTHH:mm) в часовом поясе браузера. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Значение datetime-local (локальное время) → ISO UTC. null — пусто или некорректно. */
export function localInputToIso(value: string): string | null {
  if (!LOCAL_DATETIME_RE.test(value)) return null;
  const d = new Date(value); // без смещения — локальное время (ECMAScript)
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseDate(value: string): [number, number, number] | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

/** Дата (YYYY-MM-DD) → ISO начала этих суток в локальном часовом поясе. */
export function dateStartIso(value: string): string | null {
  const p = parseDate(value);
  return p ? new Date(p[0], p[1], p[2]).toISOString() : null;
}

/** Дата (YYYY-MM-DD) → ISO начала следующих суток (конец периода не включается). */
export function dateEndExclusiveIso(value: string): string | null {
  const p = parseDate(value);
  return p ? new Date(p[0], p[1], p[2] + 1).toISOString() : null;
}

export function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Период «последние N дней» включая сегодня. */
export function lastDays(days: number, now: Date = new Date()): { from: string; to: string } {
  return { from: toDateInput(addDays(now, -(days - 1))), to: toDateInput(now) };
}

/** Значения по умолчанию для новой группы: старт — текущая минута, показ — неделю. */
export function defaultSchedule(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(now.getTime());
  start.setSeconds(0, 0);
  return { start: isoToLocalInput(start.toISOString()), end: isoToLocalInput(addDays(start, 7).toISOString()) };
}

export function timeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short' });
const dateTimeSecondsFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeFormat.format(d);
}

export function formatDateTimeSeconds(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeSecondsFormat.format(d);
}

/** YYYY-MM-DD → дата без сдвига часового пояса. */
export function formatDay(value: string): string {
  const p = parseDate(value);
  return p ? dateFormat.format(new Date(p[0], p[1], p[2])) : value;
}
