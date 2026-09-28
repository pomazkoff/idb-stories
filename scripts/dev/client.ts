/** Общие хелперы dev-скриптов: вход через mock SSO, вызовы admin API, загрузка медиа. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'apps/worker/package.json'));
// sharp — зависимость воркера; для dev-скриптов достаточно создать однотонную картинку.
type Sharp = (input: {
  create: { width: number; height: number; channels: 3; background: string };
}) => { jpeg(): { toBuffer(): Promise<Buffer> } };
export const sharp = require('sharp') as Sharp;

export const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:8081';
export const PUBLIC = process.env.PUBLIC_URL ?? 'http://localhost:8080';
export const S3 = process.env.S3_URL ?? 'http://localhost:9000';

export interface Session {
  cookie: string;
  csrf: string;
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((c) => !c.endsWith('='));

export async function login(subject: string): Promise<Session> {
  const start = await fetch(`${ADMIN}/admin/v1/auth/login`, { redirect: 'manual' });
  const loginCookie = cookiesOf(start).join('; ');
  const authorize = new URL(start.headers.get('location')!);
  const idp = await fetch(`${ADMIN}/admin/v1/dev/mock-idp/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      subject,
      state: authorize.searchParams.get('state')!,
      nonce: authorize.searchParams.get('nonce')!,
    }),
  });
  const callback = new URL(idp.headers.get('location')!);
  const done = await fetch(`${ADMIN}${callback.pathname}${callback.search}`, {
    redirect: 'manual',
    headers: { cookie: loginCookie },
  });
  const cookie = cookiesOf(done).find((c) => c.includes('stories_sid='));
  assert.ok(cookie, `вход ${subject} не удался: ${done.status}`);
  const me = (await (await fetch(`${ADMIN}/admin/v1/auth/me`, { headers: { cookie } })).json()) as {
    csrfToken: string;
  };
  return { cookie, csrf: me.csrfToken };
}

export async function api<T>(
  s: Session,
  method: string,
  url: string,
  body?: unknown,
  expect = [200, 201, 202, 204],
): Promise<T> {
  const res = await fetch(`${ADMIN}/admin/v1${url}`, {
    method,
    headers: {
      cookie: s.cookie,
      'x-csrf-token': s.csrf,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  assert.ok(expect.includes(res.status), `${method} ${url} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

interface Upload {
  asset: { id: string };
  upload: { url: string; headers: Record<string, string> };
}
interface Media {
  status: string;
  rejectReason: string | null;
  previews: { url: string }[];
}

export async function upload(
  s: Session,
  data: Buffer,
  purpose: 'slide' | 'cover',
): Promise<string> {
  const { asset, upload: up } = await api<Upload>(s, 'POST', '/media/upload-url', {
    kind: 'image',
    purpose,
    contentType: 'image/jpeg',
    size: data.length,
    fileName: `${purpose}.jpg`,
  });
  // Подпись фиксирует размер: файл другого размера по той же ссылке не загрузить.
  const tampered = await fetch(up.url, {
    method: 'PUT',
    headers: up.headers,
    body: Buffer.concat([data, Buffer.from('xx')]),
  });
  assert.equal(tampered.status, 403, 'presigned PUT принял файл другого размера');
  const put = await fetch(up.url, { method: 'PUT', headers: up.headers, body: data });
  assert.equal(put.status, 200, `PUT в quarantine: ${put.status}`);
  await api(s, 'POST', `/media/${asset.id}/complete`);
  for (let i = 0; i < 60; i++) {
    const m = await api<Media>(s, 'GET', `/media/${asset.id}`);
    if (m.status === 'ready') {
      const preview = await fetch(m.previews[0]!.url);
      assert.equal(preview.status, 200, 'подписанное превью не открылось');
      const unsigned = await fetch(m.previews[0]!.url.split('?')[0]!);
      assert.equal(unsigned.status, 403, 'черновое медиа доступно без подписи');
      return asset.id;
    }
    assert.notEqual(m.status, 'rejected', `медиа отклонено: ${m.rejectReason}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('медиа не обработано за 30 секунд');
}
