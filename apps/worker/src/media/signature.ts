/**
 * Определение типа файла по сигнатуре (magic bytes), а не по расширению или Content-Type
 * (раздел 7). Разрешены только JPEG, PNG, WebP, MP4, MOV. Всё остальное — отказ с понятной причиной.
 */
export type DetectedType =
  | { kind: 'image'; mime: 'image/jpeg' | 'image/png' | 'image/webp' }
  | { kind: 'video'; mime: 'video/mp4' | 'video/quicktime'; brand: string }
  | { kind: 'forbidden'; name: string }
  | { kind: 'unknown' };

const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'M4VP',
  'mmp4',
  'dash',
  'MSNV',
  'XAVC',
]);
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'avif',
  'avis',
  'miaf',
]);

const ascii = (buf: Buffer, start: number, end: number) =>
  buf.length >= end ? buf.toString('latin1', start, end) : '';

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

export function detectType(head: Buffer): DetectedType {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: 'image', mime: 'image/png' };
  if (ascii(head, 0, 4) === 'RIFF') {
    const form = ascii(head, 8, 12);
    if (form === 'WEBP') return { kind: 'image', mime: 'image/webp' };
    return { kind: 'forbidden', name: form === 'AVI ' ? 'AVI' : 'RIFF' };
  }
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (HEIF_BRANDS.has(brand))
      return { kind: 'forbidden', name: brand.startsWith('av') ? 'AVIF' : 'HEIC/HEIF' };
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', brand };
    if (MP4_BRANDS.has(brand)) return { kind: 'video', mime: 'video/mp4', brand };
    return { kind: 'forbidden', name: `ISO BMFF (${brand.trim() || '?'})` };
  }
  const six = ascii(head, 0, 6);
  if (six === 'GIF87a' || six === 'GIF89a') return { kind: 'forbidden', name: 'GIF' };
  if (ascii(head, 0, 4) === '%PDF') return { kind: 'forbidden', name: 'PDF' };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return { kind: 'forbidden', name: 'ZIP' };
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return { kind: 'forbidden', name: 'ELF' };
  if (ascii(head, 0, 2) === 'MZ') return { kind: 'forbidden', name: 'EXE' };
  if (ascii(head, 0, 2) === 'BM') return { kind: 'forbidden', name: 'BMP' };
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { kind: 'forbidden', name: 'TIFF' };
  }
  // Текстовые форматы: SVG, XML, HTML (с BOM и пробелами в начале).
  const text = head
    .toString('utf8', 0, Math.min(head.length, 512))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (text.startsWith('<')) {
    if (text.includes('<svg')) return { kind: 'forbidden', name: 'SVG' };
    if (text.startsWith('<!doctype html') || text.includes('<html'))
      return { kind: 'forbidden', name: 'HTML' };
    return { kind: 'forbidden', name: 'XML' };
  }
  return { kind: 'unknown' };
}

/** Заявленный Content-Type должен совпадать с реальным (MP4 и MOV — одно семейство). */
export function declaredMatches(declared: string, detected: DetectedType): boolean {
  if (detected.kind === 'image') return declared === detected.mime;
  if (detected.kind === 'video') return declared === 'video/mp4' || declared === 'video/quicktime';
  return false;
}
