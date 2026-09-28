import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../../i18n/ru.js';
import { SETTINGS, makeGroup, makeMe, mockApi, renderApp, uuid } from '../../test/utils.js';

const IMG = '<img src=x onerror=alert(1)>';
const SCRIPT = '<script>alert(1)</script>';

const group = makeGroup({
  title: IMG,
  slides: [
    {
      id: uuid(201),
      position: 0,
      type: 'product',
      durationMs: 6000,
      mediaAssetId: null,
      productSkus: ['SKU1'],
      elements: [
        { kind: 'text', text: SCRIPT, style: 'title', position: 'top' },
        { kind: 'text', text: IMG, style: 'body', position: 'bottom' },
      ],
      cta: { type: 'url', value: 'https://iledebeaute.ru/x', label: IMG.slice(0, 24) },
    },
  ],
});

const preview = {
  feed: {
    schema_version: 1,
    generated_at: '2026-09-28T10:00:00.000Z',
    ttl_sec: 60,
    groups: [
      {
        id: group.id,
        version: 3,
        title: IMG,
        cover: { url: 'https://s3.example/cover.webp', w: 256, h: 256 },
        slides: [
          {
            id: uuid(201),
            type: 'product',
            duration_ms: 6000,
            product_skus: ['SKU1'],
            elements: [{ kind: 'text', text: SCRIPT, style: 'title', position: 'top' }],
            cta: null,
          },
        ],
      },
    ],
  },
  mediaOrigins: ['https://s3.example'],
  warnings: [IMG],
};

function setup(path: string) {
  mockApi({
    'GET /admin/v1/auth/me': () => ({ body: makeMe(['editor']) }),
    'GET /admin/v1/settings': () => ({ body: SETTINGS }),
    'GET /admin/v1/segments': () => ({ body: { items: [{ id: 'seg-1', name: IMG }] } }),
    'GET /admin/v1/groups': () => ({ body: { items: [group], nextCursor: null } }),
    'GET /admin/v1/groups/:id': () => ({ body: group }),
    'GET /admin/v1/groups/:id/preview': () => ({ body: preview }),
    'GET /admin/v1/catalog/products': () => ({
      body: { items: [{ sku: 'SKU1', name: IMG, priceRub: 100, inStock: true, imageUrl: null }] },
    }),
  });
  return renderApp(path);
}

function assertNoInjectedMarkup() {
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(document.querySelector('img[onerror]')).toBeNull();
  expect(Array.from(document.querySelectorAll('script')).some((s) => s.textContent?.includes('alert'))).toBe(false);
}

describe('XSS: пользовательский текст — только текст (раздел 10.11)', () => {
  it('название группы в списке выводится буквально', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    setup('/groups');
    const link = await screen.findByRole('link', { name: IMG });
    expect(link.textContent).toBe(IMG);
    assertNoInjectedMarkup();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('название, тексты слайда и CTA в редакторе выводятся буквально', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    setup(`/groups/${group.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: IMG })).toBeTruthy();
    const list = await screen.findByRole('list', { name: ru.slides.listLabel });
    expect(within(list).getByText(SCRIPT)).toBeTruthy();
    // Поля ввода содержат тот же текст как значение.
    expect(screen.getAllByDisplayValue(IMG).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByDisplayValue(SCRIPT)).toBeTruthy();
    // Предупреждение превью и имя сегмента — тоже текст.
    expect(await screen.findByText(IMG, { selector: '.alert__list li' })).toBeTruthy();
    expect(await screen.findByText(IMG, { selector: '.segments span' })).toBeTruthy();

    assertNoInjectedMarkup();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
