import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, maskSecrets } from '../src/logger.js';

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    name: 't',
    level: 'debug',
    destination: new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    }),
  });
  return { logger, text: () => lines.join('\n') };
}

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const PRESIGNED =
  'https://s3.example/stories-quarantine/uploads/x?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAXXX%2F20260928&X-Amz-Signature=deadbeefcafebabe&X-Amz-Expires=600';

describe('раздел 10.11: логи не содержат токенов, cookie и presigned URL', () => {
  it('маскирует заголовки запроса, cookie и Set-Cookie', () => {
    const { logger, text } = capture();
    logger.info(
      {
        req: {
          method: 'GET',
          url: '/admin/v1/auth/callback?code=secret-code&state=secret-state',
          headers: {
            authorization: `Bearer ${JWT}`,
            cookie: '__Host-stories_sid=SESSIONSECRET123',
          },
        },
        res: {
          statusCode: 200,
          headers: { 'set-cookie': '__Host-stories_sid=SESSIONSECRET456; HttpOnly' },
        },
      },
      'request',
    );
    const out = text();
    expect(out).not.toContain('SESSIONSECRET');
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('secret-code');
    expect(out).not.toContain('secret-state');
  });

  it('маскирует токены и подписи в сообщениях, вложенных объектах и ошибках', () => {
    const { logger, text } = capture();
    logger.warn(`upstream said: Authorization: Bearer ${JWT}`);
    logger.info(
      {
        upload: { url: PRESIGNED, headers: { 'Content-Type': 'image/jpeg' } },
        nested: { deeper: { link: PRESIGNED } },
      },
      'upload',
    );
    logger.info(
      { token: 'plain-token-value', csrfToken: 'csrf-value', password: 'p@ss' },
      'secrets',
    );
    logger.error(
      { err: new Error(`failed GET ${PRESIGNED} with cookie stories_sid=abcdef123`) },
      'boom',
    );
    const out = text();
    for (const secret of [
      JWT,
      'deadbeefcafebabe',
      'AKIAXXX',
      'plain-token-value',
      'csrf-value',
      'p@ss',
      'abcdef123',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[REDACTED]');
  });

  it('maskSecrets не портит обычный текст', () => {
    expect(maskSecrets('Группа 7c1e опубликована, версия 3')).toBe(
      'Группа 7c1e опубликована, версия 3',
    );
  });
});
