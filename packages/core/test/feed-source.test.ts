import { describe, expect, it } from 'vitest';
import {
  diffSourceViews,
  toSourceView,
  type GroupSourceView,
  type SourceGroupInput,
} from '../src/feed/source.js';

const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';
const S3 = '00000000-0000-4000-8000-000000000003';

const textEl = { kind: 'text', text: 'Скидка', style: 'title', position: 'top' };
const cta = { type: 'product', value: 'SKU1', label: 'Купить' };

function input(overrides: Partial<SourceGroupInput> = {}): SourceGroupInput {
  return {
    title: 'Осенняя распродажа',
    placement: 'home',
    priority: 5,
    startAt: new Date('2026-10-01T09:00:00Z'),
    endAt: new Date('2026-10-08T09:00:00Z'),
    platforms: ['web', 'ios', 'android'],
    minAppVersionIos: '5.0.0',
    minAppVersionAndroid: null,
    segmentIds: ['seg-b', 'seg-a'],
    coverAssetId: 'cover-1',
    slides: [
      {
        id: S2,
        position: 7,
        type: 'image',
        durationMs: 5000,
        mediaAssetId: 'media-2',
        elements: null,
        cta: undefined,
        productSkus: [],
      },
      {
        id: S1,
        position: 3,
        type: 'product',
        durationMs: 6000,
        mediaAssetId: null,
        elements: [textEl],
        cta,
        productSkus: ['SKU1', 'SKU2'],
      },
    ],
    ...overrides,
  };
}

function view(): GroupSourceView {
  return toSourceView(input());
}

describe('toSourceView', () => {
  it('нормализует рабочую копию: сортирует платформы и сегменты, даты в ISO', () => {
    const src = input();
    const v = toSourceView(src);

    expect(v).toMatchObject({
      title: 'Осенняя распродажа',
      placement: 'home',
      priority: 5,
      startAt: '2026-10-01T09:00:00.000Z',
      endAt: '2026-10-08T09:00:00.000Z',
      platforms: ['android', 'ios', 'web'],
      minAppVersion: { ios: '5.0.0', android: null },
      segmentIds: ['seg-a', 'seg-b'],
      coverAssetId: 'cover-1',
    });
    // Исходные массивы не мутируются.
    expect(src.platforms).toEqual(['web', 'ios', 'android']);
    expect(src.segmentIds).toEqual(['seg-b', 'seg-a']);
  });

  it('слайды упорядочены по position и перенумерованы с нуля; пустые elements/cta — по умолчанию', () => {
    const src = input();
    const v = toSourceView(src);

    expect(v.slides).toEqual([
      {
        id: S1,
        position: 0,
        type: 'product',
        durationMs: 6000,
        mediaAssetId: null,
        elements: [textEl],
        cta,
        productSkus: ['SKU1', 'SKU2'],
      },
      {
        id: S2,
        position: 1,
        type: 'image',
        durationMs: 5000,
        mediaAssetId: 'media-2',
        elements: [],
        cta: null,
        productSkus: [],
      },
    ]);
    // Порядок исходных слайдов и массив SKU не разделяются с представлением.
    expect(src.slides.map((s) => s.id)).toEqual([S2, S1]);
    expect(v.slides[0]?.productSkus).not.toBe(src.slides[1]?.productSkus);
  });

  it('группа без слайдов даёт пустой список', () => {
    expect(toSourceView(input({ slides: [] })).slides).toEqual([]);
  });

  it('одинаковое содержимое в разном порядке даёт одинаковое представление', () => {
    const a = toSourceView(input());
    const b = toSourceView(
      input({
        platforms: ['android', 'web', 'ios'],
        segmentIds: ['seg-a', 'seg-b'],
        slides: [...input().slides].reverse(),
      }),
    );
    expect(b).toEqual(a);
    expect(diffSourceViews(a, b)).toEqual([]);
  });
});

describe('diffSourceViews', () => {
  it('без предыдущей версии: все заполненные поля и все слайды — добавлены', () => {
    const v = view();
    expect(diffSourceViews(null, v)).toEqual([
      { path: 'title', before: null, after: 'Осенняя распродажа' },
      { path: 'placement', before: null, after: 'home' },
      { path: 'priority', before: null, after: 5 },
      { path: 'startAt', before: null, after: '2026-10-01T09:00:00.000Z' },
      { path: 'endAt', before: null, after: '2026-10-08T09:00:00.000Z' },
      { path: 'platforms', before: null, after: ['android', 'ios', 'web'] },
      { path: 'minAppVersion', before: null, after: { ios: '5.0.0', android: null } },
      { path: 'segmentIds', before: null, after: ['seg-a', 'seg-b'] },
      { path: 'coverAssetId', before: null, after: 'cover-1' },
      { path: `slides[${S1}]`, before: null, after: v.slides[0] },
      { path: `slides[${S2}]`, before: null, after: v.slides[1] },
    ]);
  });

  it('без предыдущей версии незаполненная обложка изменением не считается', () => {
    const v = toSourceView(input({ coverAssetId: null, slides: [] }));
    const paths = diffSourceViews(null, v).map((c) => c.path);
    expect(paths).not.toContain('coverAssetId');
    expect(paths).toHaveLength(8);
  });

  it('одинаковые версии — изменений нет', () => {
    expect(diffSourceViews(view(), view())).toEqual([]);
  });

  it('изменения полей группы: before/after по каждому полю', () => {
    const before = view();
    const after = toSourceView(
      input({
        title: 'Зимняя распродажа',
        placement: 'cart',
        priority: 9,
        startAt: new Date('2026-12-01T00:00:00Z'),
        endAt: new Date('2026-12-31T00:00:00Z'),
        platforms: ['ios'],
        minAppVersionAndroid: '8.0.0',
        segmentIds: [],
        coverAssetId: null,
      }),
    );

    expect(diffSourceViews(before, after)).toEqual([
      { path: 'title', before: 'Осенняя распродажа', after: 'Зимняя распродажа' },
      { path: 'placement', before: 'home', after: 'cart' },
      { path: 'priority', before: 5, after: 9 },
      { path: 'startAt', before: '2026-10-01T09:00:00.000Z', after: '2026-12-01T00:00:00.000Z' },
      { path: 'endAt', before: '2026-10-08T09:00:00.000Z', after: '2026-12-31T00:00:00.000Z' },
      { path: 'platforms', before: ['android', 'ios', 'web'], after: ['ios'] },
      {
        path: 'minAppVersion',
        before: { ios: '5.0.0', android: null },
        after: { ios: '5.0.0', android: '8.0.0' },
      },
      { path: 'segmentIds', before: ['seg-a', 'seg-b'], after: [] },
      { path: 'coverAssetId', before: 'cover-1', after: null },
    ]);
  });

  it('изменение каждого поля слайда даёт отдельную запись с путём slides[id].поле', () => {
    const before = view();
    const src = input();
    const [s2, s1] = src.slides;
    if (!s1 || !s2) throw new Error('fixture');
    const after = toSourceView({
      ...src,
      slides: [
        s2,
        {
          ...s1,
          type: 'video',
          durationMs: 15000,
          mediaAssetId: 'media-9',
          elements: [],
          cta: null,
          productSkus: ['SKU3'],
        },
      ],
    });

    expect(diffSourceViews(before, after)).toEqual([
      { path: `slides[${S1}].type`, before: 'product', after: 'video' },
      { path: `slides[${S1}].durationMs`, before: 6000, after: 15000 },
      { path: `slides[${S1}].mediaAssetId`, before: null, after: 'media-9' },
      { path: `slides[${S1}].elements`, before: [textEl], after: [] },
      { path: `slides[${S1}].cta`, before: cta, after: null },
      { path: `slides[${S1}].productSkus`, before: ['SKU1', 'SKU2'], after: ['SKU3'] },
    ]);
  });

  it('изменённый текст элемента и CTA замечаются по содержимому', () => {
    const before = view();
    const src = input();
    const after = toSourceView({
      ...src,
      slides: src.slides.map((s) =>
        s.id === S1
          ? {
              ...s,
              elements: [{ ...textEl, text: 'Скидка 30%' }],
              cta: { ...cta, label: 'В корзину' },
            }
          : s,
      ),
    });

    expect(diffSourceViews(before, after)).toEqual([
      {
        path: `slides[${S1}].elements`,
        before: [textEl],
        after: [{ ...textEl, text: 'Скидка 30%' }],
      },
      { path: `slides[${S1}].cta`, before: cta, after: { ...cta, label: 'В корзину' } },
    ]);
  });

  it('удалённый слайд: before — слайд, after — null; оставшийся сдвигается', () => {
    const before = view();
    const src = input();
    const after = toSourceView({ ...src, slides: src.slides.filter((s) => s.id === S2) });

    expect(diffSourceViews(before, after)).toEqual([
      { path: `slides[${S2}].position`, before: 1, after: 0 },
      { path: `slides[${S1}]`, before: before.slides[0], after: null },
    ]);
  });

  it('добавленный слайд в конец: только запись о добавлении', () => {
    const before = view();
    const src = input();
    const added = {
      id: S3,
      position: 99,
      type: 'image' as const,
      durationMs: 4000,
      mediaAssetId: 'media-3',
      elements: [],
      cta: null,
      productSkus: [],
    };
    const after = toSourceView({ ...src, slides: [...src.slides, added] });

    expect(diffSourceViews(before, after)).toEqual([
      { path: `slides[${S3}]`, before: null, after: { ...added, position: 2 } },
    ]);
  });

  it('перестановка слайдов отражается изменением position у каждого', () => {
    const before = view();
    const src = input();
    const after = toSourceView({
      ...src,
      slides: src.slides.map((s) => ({ ...s, position: s.id === S1 ? 10 : 1 })),
    });

    expect(after.slides.map((s) => s.id)).toEqual([S2, S1]);
    expect(diffSourceViews(before, after)).toEqual([
      { path: `slides[${S2}].position`, before: 1, after: 0 },
      { path: `slides[${S1}].position`, before: 0, after: 1 },
    ]);
  });

  it('все слайды заменены: новые добавлены, старые удалены', () => {
    const before = view();
    const after = toSourceView(
      input({
        slides: [
          {
            id: S3,
            position: 0,
            type: 'video',
            durationMs: 10000,
            mediaAssetId: 'media-3',
            elements: undefined,
            cta: null,
            productSkus: [],
          },
        ],
      }),
    );

    expect(diffSourceViews(before, after)).toEqual([
      { path: `slides[${S3}]`, before: null, after: after.slides[0] },
      { path: `slides[${S1}]`, before: before.slides[0], after: null },
      { path: `slides[${S2}]`, before: before.slides[1], after: null },
    ]);
  });
});
