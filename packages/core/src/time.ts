/**
 * Рабочее время для алерта «публикация вне рабочего времени» (раздел 10.9).
 * TODO(spec): уточнить у ИБ часы и календарь праздников. Пока пн–пт 09:00–20:00 по Москве.
 */
export function isBusinessHours(date: Date, timeZone = 'Europe/Moscow'): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return !['Sat', 'Sun'].includes(weekday) && hour >= 9 && hour < 20;
}

/** Календарная дата (YYYY-MM-DD) в часовом поясе статистики. */
export function dayInZone(date: Date, timeZone = 'Europe/Moscow'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
