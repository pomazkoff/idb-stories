import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openViewer, type CatalogProduct, type PlayerOptions } from '../src/index.js';
import {
  baseOptions,
  click,
  currentTitle,
  expectValidEvents,
  gid,
  group,
  imageSlide,
  makeFeed,
  mockStageWidth,
  ofType,
  productSlide,
  sid,
  viewerRoot,
} from './helpers.js';

const CATALOG: Record<string, CatalogProduct> = {
  SKU001: {
    sku: 'SKU001',
    name: 'Парфюмерная вода',
    priceRub: 1990,
    inStock: true,
    imageUrl: 'https://img.idb.example/1.jpg',
  },
  SKU002: {
    sku: 'SKU002',
    name: 'Крем для лица',
    priceRub: 12500.5,
    inStock: false,
    imageUrl: null,
  },
  SKU003: {
    sku: 'SKU003',
    name: '<img src=x onerror=alert(1)>',
    priceRub: 590,
    inStock: true,
    imageUrl: 'javascript:alert(1)',
  },
};

const getProducts = vi.fn((skus: string[]) =>
  Promise.resolve(skus.flatMap((s) => (CATALOG[s] ? [CATALOG[s]] : []))),
);

let handle: { close(): void } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  getProducts.mockClear();
});

afterEach(() => {
  handle?.close();
  handle = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(skus: string[], extra: Partial<PlayerOptions> = {}) {
  const feed = makeFeed([group(1, [productSlide(1, 1, skus), imageSlide(1, 2)])]);
  const { options, events } = baseOptions({ getProducts, ...extra });
  handle = openViewer(feed, 0, options);
  if (document.querySelector('.idbs-viewer')) mockStageWidth(300);
  await vi.advanceTimersByTimeAsync(0);
  return events;
}

const cards = () => [...viewerRoot().querySelectorAll('.idbs-product')];

describe('слайд с товарами', () => {
  it('запрашивает товары по SKU и показывает только те, что в наличии', async () => {
    await open(['SKU001', 'SKU002', 'SKU003']);
    expect(getProducts).toHaveBeenCalledWith(['SKU001', 'SKU002', 'SKU003']);
    const list = cards();
    expect(list).toHaveLength(2);
    expect(list[0]!.querySelector('.idbs-product__name')!.textContent).toBe('Парфюмерная вода');
    expect(list[0]!.querySelector('.idbs-product__price')!.textContent).toBe('1\u00A0990\u00A0₽');
    expect(list[0]!.querySelector('img')!.getAttribute('src')).toBe(
      'https://img.idb.example/1.jpg',
    );
    // Название — только текст, опасный imageUrl отброшен.
    expect(list[1]!.querySelector('.idbs-product__name')!.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
    expect(list[1]!.querySelector('img')).toBeNull();
    expect(viewerRoot().querySelectorAll('[onerror]')).toHaveLength(0);
  });

  it('если ни одного товара нет в наличии — слайд пропускается', async () => {
    const events = await open(['SKU002']);
    expect(currentTitle()).toBe('Слайд 1.2');
    expect(viewerRoot().querySelector<HTMLElement>('.idbs-progress__seg')!.hidden).toBe(true);
    expect(ofType(events, 'story_media_error')).toHaveLength(0);
  });

  it('ошибка каталога — слайд пропускается', async () => {
    await open(['SKU001'], { getProducts: () => Promise.reject(new Error('503')) });
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('без getProducts слайды с товарами не показываются вовсе', async () => {
    await open(['SKU001'], { getProducts: undefined });
    expect(viewerRoot().querySelectorAll('.idbs-progress__seg')).toHaveLength(1);
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('товары с чужими SKU из ответа каталога игнорируются, порядок — как в слайде', async () => {
    await open(['SKU003', 'SKU001'], {
      getProducts: () =>
        Promise.resolve([CATALOG.SKU001!, { ...CATALOG.SKU001!, sku: 'FOREIGN' }, CATALOG.SKU003!]),
    });
    expect(cards().map((c) => c.querySelector('.idbs-product__name')!.textContent)).toEqual([
      '<img src=x onerror=alert(1)>',
      'Парфюмерная вода',
    ]);
  });

  it('«В корзину» вызывает onAddToCart и после успеха шлёт story_add_to_cart', async () => {
    const onAddToCart = vi.fn(() => Promise.resolve());
    const events = await open(['SKU001'], { onAddToCart });
    const btn = cards()[0]!.querySelector<HTMLButtonElement>('.idbs-product__cart')!;
    expect(btn.textContent).toBe('В корзину');
    click(btn);
    expect(btn.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onAddToCart).toHaveBeenCalledWith('SKU001', `${gid(1)}:${sid(1, 1)}`);
    const add = ofType(events, 'story_add_to_cart');
    expect(add).toHaveLength(1);
    expect(add[0]).toMatchObject({ sku: 'SKU001', slide_type: 'product', slide_index: 0 });
    expect(btn.textContent).toBe('Добавлено');
    expectValidEvents(events);
  });

  it('если onAddToCart упал — события нет, кнопку можно нажать снова', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onAddToCart = vi.fn(() => Promise.reject(new Error('cart down')));
    const events = await open(['SKU001'], { onAddToCart });
    const btn = cards()[0]!.querySelector<HTMLButtonElement>('.idbs-product__cart')!;
    click(btn);
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType(events, 'story_add_to_cart')).toHaveLength(0);
    expect(btn.disabled).toBe(false);
  });

  it('без onAddToCart кнопки «В корзину» нет', async () => {
    await open(['SKU001']);
    expect(cards()[0]!.querySelector('.idbs-product__cart')).toBeNull();
  });

  it('клик по карточке — story_product_click и onCta с типом product', async () => {
    const onCta = vi.fn();
    const events = await open(['SKU001'], { onCta });
    click(cards()[0]!.querySelector('.idbs-product__main'));
    const ev = ofType(events, 'story_product_click');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ sku: 'SKU001', group_id: gid(1), slide_id: sid(1, 1) });
    expect(onCta).toHaveBeenCalledWith({
      type: 'product',
      value: 'SKU001',
      href: null,
      storyRef: `${gid(1)}:${sid(1, 1)}`,
    });
    expect(ofType(events, 'story_cta_click')).toHaveLength(0);
    expectValidEvents(events);
  });

  it('товары следующего слайда запрашиваются заранее (предзагрузка)', async () => {
    const feed = makeFeed([group(1, [imageSlide(1, 1), productSlide(1, 2, ['SKU001'])])]);
    handle = openViewer(feed, 0, baseOptions({ getProducts }).options);
    await vi.advanceTimersByTimeAsync(0);
    expect(getProducts).toHaveBeenCalledTimes(1);
  });

  it('таймер слайда с товарами идёт после загрузки товаров', async () => {
    await open(['SKU001']);
    expect(cards()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(currentTitle()).toBe('Слайд 1.2');
  });
});
