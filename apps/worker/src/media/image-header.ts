/**
 * Размеры изображения из заголовка — без декодирования, чтобы отсечь «бомбы по разрешению»
 * до того, как libvips начнёт выделять память. Результат сверяется с метаданными sharp.
 */
export interface HeaderInfo {
  width: number;
  height: number;
  animated: boolean;
}

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function png(buf: Buffer): HeaderInfo | null {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    animated: buf.includes('acTL'),
  };
}

function jpeg(buf: Buffer): HeaderInfo | null {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    let marker = buf[off + 1]!;
    while (marker === 0xff && off + 2 < buf.length) {
      off += 1;
      marker = buf[off + 1]!;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (off + 9 > buf.length) return null;
      return {
        height: buf.readUInt16BE(off + 5),
        width: buf.readUInt16BE(off + 7),
        animated: false,
      };
    }
    off += 2 + len;
  }
  return null;
}

function webp(buf: Buffer): HeaderInfo | null {
  if (buf.length < 30) return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
      animated: false,
    };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const b0 = buf[21]!,
      b1 = buf[22]!,
      b2 = buf[23]!,
      b3 = buf[24]!;
    return {
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
      animated: false,
    };
  }
  if (chunk === 'VP8X') {
    const flags = buf[20]!;
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
      animated: (flags & 0x02) !== 0,
    };
  }
  return null;
}

export function readImageHeader(
  mime: 'image/jpeg' | 'image/png' | 'image/webp',
  head: Buffer,
): HeaderInfo | null {
  if (mime === 'image/png') return png(head);
  if (mime === 'image/jpeg') return jpeg(head);
  return webp(head);
}
