const numberFormat = new Intl.NumberFormat('ru-RU');
const percentFormat = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 });

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : numberFormat.format(value);
}

/** Доля 0..1 → «12,3 %». null — «—» (нет знаменателя). */
export function formatPercent(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined ? '—' : percentFormat.format(ratio);
}

/** Ширина полоски воронки в процентах (0–100) для CSS. */
export function barWidth(ratio: number | null | undefined): string {
  const r = ratio ?? 0;
  const clamped = Math.max(0, Math.min(1, r));
  return `${Math.round(clamped * 1000) / 10}%`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
