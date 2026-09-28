import type { GroupDiff } from '@idb-stories/schema';
import { describe, expect, it } from 'vitest';
import { ru } from '../i18n/ru.js';
import { buildCreate, buildUpdate, draftFromGroup, newGroupDraft } from '../pages/groups/metaDraft.js';
import { buildSlide, newSlideDraft } from '../pages/groups/slideDraft.js';
import { makeGroup } from '../test/utils.js';
import { dateEndExclusiveIso, dateStartIso, isoToLocalInput, lastDays, localInputToIso } from './datetime.js';
import { describeDiff } from './diff.js';

const ALLOWLIST = { deeplinkSchemes: ['idb'], urlDomains: ['iledebeaute.ru'] };

describe('даты', () => {
  it('datetime-local ↔ ISO сохраняют момент времени', () => {
    const iso = '2026-10-01T09:30:00.000Z';
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('2026-13-45T99:99')).toBeNull();
  });

  it('период по датам — [начало дня, начало следующего дня)', () => {
    const from = dateStartIso('2026-09-28')!;
    const to = dateEndExclusiveIso('2026-09-28')!;
    expect(Date.parse(to) - Date.parse(from)).toBe(24 * 3600 * 1000);
    expect(lastDays(7, new Date(2026, 8, 28, 15))).toEqual({ from: '2026-09-22', to: '2026-09-28' });
  });
});

describe('форма группы', () => {
  it('создание: значения по умолчанию проходят схему, кроме пустого названия', () => {
    const draft = newGroupDraft(new Date(2026, 8, 28, 10, 15, 42));
    expect(draft.start).toBe('2026-09-28T10:15');
    expect(draft.end).toBe('2026-10-05T10:15');
    const empty = buildCreate(draft);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.title).toBeTruthy();

    const ok = buildCreate({ ...draft, title: '  Осень  ', minIos: '5.12.0' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.body.title).toBe('Осень');
      expect(ok.body.startAt).toBe(new Date(2026, 8, 28, 10, 15).toISOString());
      expect(ok.body.minAppVersion).toEqual({ ios: '5.12.0', android: null });
      expect(ok.body.platforms).toEqual(['ios', 'android', 'web']);
    }
  });

  it('ошибки: окончание раньше начала, версия, платформы', () => {
    const draft = { ...newGroupDraft(), title: 'X', end: '2000-01-01T00:00', minAndroid: '5', platforms: [] };
    const res = buildCreate(draft);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.endAt).toBe(ru.validation.endAfterStart);
      expect(res.errors['minAppVersion.android']).toBe('Версия в формате 5.12.0');
      expect(res.errors.platforms).toBe(ru.validation.platformsRequired);
    }
  });

  it('обновление: только изменённые поля и ревизия', () => {
    const group = makeGroup();
    const base = draftFromGroup(group);
    const res = buildUpdate({ ...base, priority: '15', placement: 'cart' }, base, 7);
    expect(res).toEqual({ ok: true, body: { placement: 'cart', priority: 15, revision: 7 } });
  });
});

describe('слайд', () => {
  it('CTA вне allowlist не пропускается на клиенте', () => {
    const draft = {
      ...newSlideDraft('product'),
      skus: 'SKU1, SKU2',
      cta: { enabled: true, type: 'url' as const, value: 'javascript:alert(1)', label: 'Купить' },
    };
    const res = buildSlide(draft, ALLOWLIST);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors['cta.value']).toBe('Схема ссылки запрещена');
  });

  it('товары: 1–6 уникальных SKU', () => {
    const tooMany = buildSlide({ ...newSlideDraft('product'), skus: 'a b c d e f g' }, ALLOWLIST);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.errors.productSkus).toBe(ru.validation.skusRange);
    const dup = buildSlide({ ...newSlideDraft('product'), skus: 'a, a' }, ALLOWLIST);
    if (!dup.ok) expect(dup.errors.productSkus).toBe(ru.validation.skusUnique);
    const ok = buildSlide({ ...newSlideDraft('product'), skus: 'A1;B2', durationSec: '8' }, ALLOWLIST);
    expect(ok).toMatchObject({ ok: true, body: { type: 'product', productSkus: ['A1', 'B2'], durationMs: 8000, cta: null } });
  });

  it('изображение без файла и с длительностью вне 3–15 с', () => {
    const res = buildSlide({ ...newSlideDraft('image'), durationSec: '20' }, ALLOWLIST);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.mediaAssetId).toBe(ru.validation.mediaRequired);
      expect(res.errors.durationMs).toBe(ru.validation.durationRange);
    }
  });
});

describe('diff для согласования', () => {
  it('номера слайдов вместо id и понятные подписи', () => {
    const diff: GroupDiff = {
      baseVersion: 1,
      revision: 5,
      changes: [
        { path: 'placement', before: 'home', after: 'cart' },
        { path: 'segmentIds', before: [], after: ['seg-vip'] },
        { path: 'slides[s2].cta', before: null, after: { type: 'url', value: 'https://iledebeaute.ru/x', label: 'Купить' } },
        { path: 'slides[s3]', before: null, after: { type: 'image', durationMs: 5000, elements: [], cta: null, productSkus: [] } },
        { path: 'slides[old]', before: { type: 'video', position: 3, elements: [], cta: null, productSkus: [] }, after: null },
      ],
    };
    const rows = describeDiff(diff, { slideIds: ['s1', 's2', 's3'], segmentNames: new Map([['seg-vip', 'VIP']]) });
    expect(rows.map((r) => [r.label, r.before, r.after])).toEqual([
      ['Площадка', 'Главная', 'Корзина'],
      ['Сегменты', 'Все покупатели', 'VIP'],
      ['Слайд 2: кнопка CTA', 'без кнопки', '«Купить» → https://iledebeaute.ru/x (Ссылка на сайт (https))'],
      ['Слайд 3 добавлен', '—', 'Изображение: 5 с'],
      ['Слайд 4 удалён', 'Видео', '—'],
    ]);
  });
});
