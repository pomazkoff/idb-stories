import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { readImageHeader } from '../src/media/image-header.js';
import { declaredMatches, detectType } from '../src/media/signature.js';

const img = (w: number, h: number, channels: 3 | 4 = 3) =>
  sharp({
    create: { width: w, height: h, channels, background: { r: 10, g: 20, b: 30, alpha: 0.5 } },
  });

describe('readImageHeader', () => {
  it('PNG, JPEG, WebP lossy/lossless/extended', async () => {
    expect(readImageHeader('image/png', await img(721, 1283).png().toBuffer())).toEqual({
      width: 721,
      height: 1283,
      animated: false,
    });
    expect(
      readImageHeader(
        'image/jpeg',
        await img(801, 1401)
          .jpeg()
          .withExif({ IFD0: { Copyright: 'x'.repeat(200) } })
          .toBuffer(),
      ),
    ).toEqual({
      width: 801,
      height: 1401,
      animated: false,
    });
    expect(readImageHeader('image/webp', await img(333, 777).webp().toBuffer())).toEqual({
      width: 333,
      height: 777,
      animated: false,
    });
    expect(
      readImageHeader('image/webp', await img(333, 777).webp({ lossless: true }).toBuffer()),
    ).toEqual({ width: 333, height: 777, animated: false });
    expect(
      readImageHeader(
        'image/webp',
        await img(333, 777, 4)
          .webp({ lossless: false })
          .withExif({ IFD0: { Artist: 'a' } })
          .toBuffer(),
      ),
    ).toEqual({
      width: 333,
      height: 777,
      animated: false,
    });
  });

  it('анимированный WebP (флаг VP8X) распознаётся', () => {
    const buf = Buffer.alloc(40);
    buf.write('RIFF', 0, 'latin1');
    buf.write('WEBP', 8, 'latin1');
    buf.write('VP8X', 12, 'latin1');
    buf[20] = 0x02;
    buf.writeUIntLE(99, 24, 3);
    buf.writeUIntLE(199, 27, 3);
    expect(readImageHeader('image/webp', buf)).toEqual({ width: 100, height: 200, animated: true });
  });

  it('APNG с acTL считается анимированным', async () => {
    const png = await img(720, 1280).png().toBuffer();
    const withActl = Buffer.concat([
      png.subarray(0, 33),
      Buffer.from([0, 0, 0, 8]),
      Buffer.from('acTL'),
      Buffer.alloc(12),
      png.subarray(33),
    ]);
    expect(readImageHeader('image/png', withActl)?.animated).toBe(true);
  });

  it('повреждённые заголовки → null', () => {
    expect(readImageHeader('image/png', Buffer.from('\x89PNG\r\n\x1a\n'))).toBeNull();
    expect(readImageHeader('image/jpeg', Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
    expect(
      readImageHeader('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0, 0])),
    ).toBeNull();
    expect(
      readImageHeader('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0])),
    ).toBeNull();
    expect(
      readImageHeader('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11])),
    ).toBeNull();
    const vp8 = Buffer.alloc(40);
    vp8.write('RIFF', 0, 'latin1');
    vp8.write('WEBPVP8 ', 8, 'latin1');
    expect(readImageHeader('image/webp', vp8)).toBeNull();
    const vp8l = Buffer.from(vp8);
    vp8l.write('VP8L', 12, 'latin1');
    expect(readImageHeader('image/webp', vp8l)).toBeNull();
    const other = Buffer.from(vp8);
    other.write('ALPH', 12, 'latin1');
    expect(readImageHeader('image/webp', other)).toBeNull();
    expect(readImageHeader('image/webp', Buffer.alloc(10))).toBeNull();
  });
});

describe('detectType', () => {
  const ftyp = (brand: string) =>
    Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from(`ftyp${brand}`), Buffer.alloc(12)]);
  it.each([
    [Buffer.from('II*\0rest'), 'TIFF'],
    [Buffer.from('MM\0*rest'), 'TIFF'],
    [Buffer.from('BMxxxx'), 'BMP'],
    [Buffer.from('\x7fELF....'), 'ELF'],
    [Buffer.from('MZ\x90\x00'), 'EXE'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]), 'AVI'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]), 'RIFF'],
    [ftyp('3gp4'), 'ISO BMFF (3gp4)'],
    [ftyp('avif'), 'AVIF'],
    [Buffer.from('<?xml version="1.0"?><rss/>'), 'XML'],
  ])('%s → forbidden %s', (buf, name) => {
    expect(detectType(buf)).toEqual({ kind: 'forbidden', name });
  });

  it('неизвестное и пустое', () => {
    expect(detectType(Buffer.alloc(0))).toEqual({ kind: 'unknown' });
    expect(detectType(Buffer.from('hello world'))).toEqual({ kind: 'unknown' });
  });

  it('MP4 и MOV', () => {
    expect(detectType(ftyp('isom'))).toMatchObject({ kind: 'video', mime: 'video/mp4' });
    expect(detectType(ftyp('qt  '))).toMatchObject({ kind: 'video', mime: 'video/quicktime' });
  });

  it('declaredMatches', () => {
    expect(declaredMatches('image/png', { kind: 'image', mime: 'image/png' })).toBe(true);
    expect(declaredMatches('image/jpeg', { kind: 'image', mime: 'image/png' })).toBe(false);
    expect(
      declaredMatches('video/mp4', { kind: 'video', mime: 'video/quicktime', brand: 'qt  ' }),
    ).toBe(true);
    expect(declaredMatches('video/quicktime', { kind: 'unknown' })).toBe(false);
  });
});
