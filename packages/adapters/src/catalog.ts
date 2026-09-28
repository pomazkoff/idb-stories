/**
 * [ИНТЕГРАЦИЯ] Каталог ИДБ: названия, цены, наличие. В ленту эти данные не попадают —
 * клиенты запрашивают каталог сами (раздел 5.1). Сервису каталог нужен только для превью в админке.
 */
export interface CatalogProduct {
  sku: string;
  name: string;
  priceRub: number;
  inStock: boolean;
  imageUrl: string | null;
}

export interface CatalogAdapter {
  readonly kind: string;
  /** Неизвестные SKU в ответ не попадают. */
  getProducts(skus: string[]): Promise<CatalogProduct[]>;
}

const NAMES = [
  'Парфюмерная вода',
  'Туалетная вода',
  'Крем для лица',
  'Сыворотка',
  'Помада',
  'Тушь для ресниц',
];

/** Mock: любой SKU вида SKU… существует; SKU с суффиксом OOS — нет в наличии. */
export class MockCatalogAdapter implements CatalogAdapter {
  readonly kind = 'mock';

  getProducts(skus: string[]): Promise<CatalogProduct[]> {
    return Promise.resolve(
      skus
        .filter((sku) => /^SKU/i.test(sku))
        .map((sku) => {
          const n = [...sku].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
          return {
            sku,
            name: `${NAMES[n % NAMES.length]} ${sku}`,
            priceRub: 990 + (n % 50) * 100,
            inStock: !/OOS$/i.test(sku),
            imageUrl: null,
          };
        }),
    );
  }
}
