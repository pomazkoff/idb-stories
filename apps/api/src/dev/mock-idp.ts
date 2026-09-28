import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import { SsoError } from '@idb-stories/adapters';
import type { AppDeps } from '../context.js';

const sanitizeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

const PAGE_CSP = "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Mock-IdP для разработки (раздел 10.2). Регистрируется только вне production;
 * конфиг дополнительно запрещает SSO_PROVIDER=mock в production на старте.
 */
export async function registerMockIdp(app: FastifyInstance, deps: AppDeps): Promise<void> {
  if (deps.config.env === 'production') throw new Error('mock-IdP нельзя включить в production');
  await app.register(formbody, { bodyLimit: 4096 });
  const callback = `${deps.config.admin.origin}/admin/v1/auth/callback`;

  app.get('/admin/v1/dev/mock-idp/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.redirect_uri !== callback || !q.state || !q.nonce) {
      return reply.code(400).type('text/plain; charset=utf-8').send('invalid request');
    }
    const users = deps.sso.users
      .map(
        (u) => `<li><form method="post" action="/admin/v1/dev/mock-idp/authorize">
<input type="hidden" name="subject" value="${sanitizeHtml(u.subject)}">
<input type="hidden" name="state" value="${sanitizeHtml(q.state ?? '')}">
<input type="hidden" name="nonce" value="${sanitizeHtml(q.nonce ?? '')}">
<button type="submit" data-subject="${sanitizeHtml(u.subject)}">${sanitizeHtml(u.name)}</button> — ${sanitizeHtml(u.email)} (${sanitizeHtml(u.hint)})
</form></li>`,
      )
      .join('\n');
    return reply
      .header('content-security-policy', PAGE_CSP)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Mock SSO (dev)</title></head>
<body><h1>Mock SSO — только для разработки</h1><p>Выберите сотрудника:</p><ul>${users}</ul></body></html>`);
  });

  app.post('/admin/v1/dev/mock-idp/authorize', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (!b.subject || !b.state || !b.nonce) return reply.code(400).send('invalid request');
    try {
      const code = deps.sso.issueCode(b.subject, b.nonce);
      const url = new URL(callback);
      url.searchParams.set('code', code);
      url.searchParams.set('state', b.state);
      return reply.redirect(url.href, 302);
    } catch (err) {
      return reply.code(400).send(err instanceof SsoError ? err.reason : 'error');
    }
  });
}
