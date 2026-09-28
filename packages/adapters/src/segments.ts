/**
 * [ИНТЕГРАЦИЯ] Сегменты покупателей ИДБ (открытый вопрос №5: источник, формат, частота синхронизации).
 * ID сегментов непрозрачны; имена видны только в админке (угроза T6).
 */
export interface SegmentInfo {
  id: string;
  name: string;
}

export interface SegmentsAdapter {
  readonly kind: string;
  /** Сегменты пользователя. Бросает AdapterUnavailableError при недоступности. */
  getUserSegments(userId: string): Promise<string[]>;
  /** Полный справочник для синхронизации в таблицу Segment. */
  listSegments(): Promise<SegmentInfo[]>;
}

export const MOCK_SEGMENTS: readonly SegmentInfo[] = [
  { id: 'seg_loyal_gold', name: 'Карта «Золотая»' },
  { id: 'seg_new_customers', name: 'Новые покупатели (30 дней)' },
  { id: 'seg_fragrance_lovers', name: 'Покупали парфюмерию' },
  { id: 'seg_moscow', name: 'Москва и МО' },
];

export class MockSegmentsAdapter implements SegmentsAdapter {
  readonly kind = 'mock';

  /** userId → сегменты. По умолчанию: `user-gold-*` в «Золотой», `user-new-*` — новые. */
  constructor(private readonly overrides: ReadonlyMap<string, string[]> = new Map()) {}

  getUserSegments(userId: string): Promise<string[]> {
    const fixed = this.overrides.get(userId);
    if (fixed) return Promise.resolve([...fixed]);
    const segments: string[] = [];
    if (userId.startsWith('user-gold')) segments.push('seg_loyal_gold');
    if (userId.startsWith('user-new')) segments.push('seg_new_customers');
    if (userId.includes('fragrance')) segments.push('seg_fragrance_lovers');
    return Promise.resolve(segments);
  }

  listSegments(): Promise<SegmentInfo[]> {
    return Promise.resolve(MOCK_SEGMENTS.map((s) => ({ ...s })));
  }
}
