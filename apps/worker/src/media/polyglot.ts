/**
 * Поиск встроенной разметки (polyglot-файлы вроде JPEG+HTML, угроза T2/T3).
 * Главная защита — обязательное перекодирование; этот поиск отклоняет подозрительные файлы
 * заранее. Маркеры не короче 6 байт: вероятность случайного совпадения в сжатых данных
 * ничтожна даже для 200 МБ видео.
 */
const MARKERS = [
  '<script',
  '<html',
  '<iframe',
  '<?php',
  '<!doctype',
  '<body',
  '<object',
  '<embed',
  'javascript:',
  '<svg xmlns',
  'onerror=',
  'onload=',
].map((m) => Buffer.from(m, 'latin1'));

const lower = (b: number) => (b >= 0x41 && b <= 0x5a ? b + 0x20 : b);

export class PolyglotScanner {
  /** Хвост предыдущего блока: маркер может разрезаться границей чанков. */
  private tail = Buffer.alloc(0);
  private readonly maxLen = Math.max(...MARKERS.map((m) => m.length));
  found: string | null = null;

  push(chunk: Buffer): void {
    if (this.found) return;
    const data = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    for (let i = 0; i < data.length; i++) {
      const c = data[i]!;
      if (c !== 0x3c && lower(c) !== 0x6a && lower(c) !== 0x6f) continue; // '<', 'j', 'o'
      for (const m of MARKERS) {
        if (lower(c) !== m[0] || i + m.length > data.length) continue;
        let ok = true;
        for (let k = 1; k < m.length; k++) {
          if (lower(data[i + k]!) !== m[k]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          this.found = m.toString('latin1');
          return;
        }
      }
    }
    this.tail = Buffer.from(data.subarray(Math.max(0, data.length - this.maxLen + 1)));
  }
}

export function findEmbeddedMarkup(data: Buffer): string | null {
  const s = new PolyglotScanner();
  s.push(data);
  return s.found;
}
