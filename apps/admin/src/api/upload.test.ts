import { LIMITS } from '@idb-stories/schema';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../i18n/ru.js';
import { CSRF, mockApi } from '../test/utils.js';
import { setCsrfToken } from './client.js';
import { checkFile, uploadMedia } from './upload.js';

function fakeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  withCredentials = true;
  headers: Record<string, string> = {};
  status = 0;
  body: unknown = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
      this.status = 200;
      this.onload?.();
    }, 0);
  }
  abort() {
    this.onabort?.();
  }
}

describe('Загрузка медиа', () => {
  it('проверяет тип и размер до запроса URL', () => {
    expect(checkFile(fakeFile('a.svg', 'image/svg+xml', 10), 'image')).toEqual({
      ok: false,
      message: ru.media.unsupportedImage,
    });
    expect(checkFile(fakeFile('a.gif', 'image/gif', 10), 'image').ok).toBe(false);
    expect(checkFile(fakeFile('a.jpg', 'image/jpeg', LIMITS.imageMaxBytes + 1), 'image')).toEqual({
      ok: false,
      message: ru.media.tooLarge(LIMITS.imageMaxBytes),
    });
    expect(checkFile(fakeFile('a.mp4', 'video/mp4', 10), 'image').ok).toBe(false);
    expect(checkFile(fakeFile('a.mov', '', 10), 'video')).toEqual({ ok: true, kind: 'video', contentType: 'video/quicktime' });
    expect(checkFile(fakeFile('a.mp4', 'video/mp4', LIMITS.videoMaxBytes + 1), 'video').ok).toBe(false);
  });

  it('upload-url → PUT через XHR ровно с выданными заголовками, без cookie → complete', async () => {
    const { requests } = mockApi({
      'POST /admin/v1/media/upload-url': () => ({
        status: 201,
        body: {
          asset: { id: 'a1' },
          upload: {
            url: 'https://s3.example/quarantine/a1?X-Amz-Signature=sig',
            method: 'PUT',
            headers: { 'Content-Type': 'image/png', 'Content-Length': '1234' },
            expiresAt: '2026-09-28T10:10:00.000Z',
          },
        },
      }),
      'POST /admin/v1/media/:id/complete': () => ({ status: 202, body: { id: 'a1', status: 'processing' } }),
    });
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    setCsrfToken(CSRF);
    const progress: number[] = [];
    const file = fakeFile('cover.png', 'image/png', 1234);

    const asset = await uploadMedia(file, 'image', 'cover', { onProgress: (f) => progress.push(f) });

    expect(asset).toMatchObject({ id: 'a1', status: 'processing' });
    expect(requests[0]!.body).toEqual({
      kind: 'image',
      purpose: 'cover',
      contentType: 'image/png',
      size: 1234,
      fileName: 'cover.png',
    });
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://s3.example/quarantine/a1?X-Amz-Signature=sig');
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(xhr.body).toBe(file);
    expect(progress).toEqual([0.5, 1]);
    expect(requests[1]!.path).toBe('/admin/v1/media/a1/complete');
    expect(requests[1]!.headers.get('X-CSRF-Token')).toBe(CSRF);
  });
});
