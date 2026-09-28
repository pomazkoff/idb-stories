import { CTA_REJECT_MESSAGES } from '@idb-stories/schema';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ru } from '../../i18n/ru.js';
import { SETTINGS, makeGroup, makeMe, mockApi, renderApp } from '../../test/utils.js';
import { CtaFields } from './CtaFields.js';
import type { CtaDraft } from './slideDraft.js';

function Harness() {
  const [cta, setCta] = useState<CtaDraft>({ enabled: true, type: 'url', value: '', label: 'Купить' });
  return <CtaFields value={cta} onChange={setCta} allowlist={SETTINGS.ctaAllowlist} disabled={false} errors={{}} />;
}

describe('CTA: проверка по allowlist', () => {
  it('javascript: отклоняется сразу при вводе', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText(ru.cta.value);
    await user.type(input, 'javascript:alert(1)');
    expect(screen.getByRole('alert').textContent).toBe(CTA_REJECT_MESSAGES.forbidden_scheme);
    expect(input.getAttribute('aria-invalid')).toBe('true');

    // Для диплинка — тоже запрещённая схема.
    await user.selectOptions(screen.getByLabelText(ru.cta.type), 'deeplink');
    expect(screen.getByRole('alert').textContent).toBe(CTA_REJECT_MESSAGES.forbidden_scheme);
  });

  it.each([
    ['https://iledebeaute.ru@evil.com/', CTA_REJECT_MESSAGES.userinfo],
    ['https://evil.example/promo', CTA_REJECT_MESSAGES.domain_not_allowed],
    ['http://iledebeaute.ru/', CTA_REJECT_MESSAGES.not_https],
    ['https://127.0.0.1/', CTA_REJECT_MESSAGES.ip_address],
  ])('%s — ошибка', async (value, message) => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText(ru.cta.value), value);
    expect(screen.getByRole('alert').textContent).toBe(message);
  });

  it('разрешённая ссылка проходит', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText(ru.cta.value), 'https://www.iledebeaute.ru/promo');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ошибка сервера cta_not_allowed показывается у поля CTA', async () => {
    const user = userEvent.setup();
    const group = makeGroup();
    mockApi({
      'GET /admin/v1/auth/me': () => ({ body: makeMe(['editor']) }),
      // Клиентский allowlist устарел: домен в нём есть, сервер уже запрещает.
      'GET /admin/v1/settings': () => ({
        body: { ...SETTINGS, ctaAllowlist: { deeplinkSchemes: ['idb'], urlDomains: ['old-partner.example'] } },
      }),
      'GET /admin/v1/segments': () => ({ body: { items: [] } }),
      'GET /admin/v1/groups/:id': () => ({ body: group }),
      'GET /admin/v1/groups/:id/preview': () => ({
        body: { feed: { schema_version: 1, generated_at: group.updatedAt, ttl_sec: 60, groups: [] }, mediaOrigins: [], warnings: [] },
      }),
      'PUT /admin/v1/groups/:id/slides/:slideId': () => ({
        status: 400,
        body: {
          error: { code: 'cta_not_allowed', message: CTA_REJECT_MESSAGES.domain_not_allowed, details: { reason: 'domain_not_allowed' } },
        },
      }),
    });
    renderApp(`/groups/${group.id}`);

    await user.click(await screen.findByLabelText(ru.cta.enable));
    await user.type(screen.getByLabelText(ru.cta.value), 'https://old-partner.example/x');
    await user.type(screen.getByLabelText(ru.cta.label), 'Купить');
    await user.click(screen.getByRole('button', { name: ru.slides.save }));

    const error = await screen.findByText(CTA_REJECT_MESSAGES.domain_not_allowed);
    const input = screen.getByLabelText(ru.cta.value);
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
