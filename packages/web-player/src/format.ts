let rubFormat: Intl.NumberFormat | null = null;

/** 1990 → «1 990 ₽» (неразрывные пробелы, как в ru-RU). */
export function formatPrice(priceRub: number): string {
  rubFormat ??= new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${rubFormat.format(priceRub)}\u00A0₽`;
}
