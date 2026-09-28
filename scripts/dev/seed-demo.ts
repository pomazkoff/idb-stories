/**
 * Демо-данные для локального стенда: несколько опубликованных групп с картинками в разных placement.
 *   pnpm dev:local   # в другом терминале
 *   pnpm seed:demo   # DEMO_GROUPS=8 по умолчанию
 */
import { api, login, sharp, upload } from './client.js';

const COLORS = [
  '#c2185b',
  '#7b1fa2',
  '#303f9f',
  '#0288d1',
  '#00796b',
  '#689f38',
  '#f57c00',
  '#5d4037',
];
const TITLES = [
  'Новинки осени',
  'Ароматы сезона',
  'Уход за кожей',
  'Выбор редакции',
  'Подарки',
  'Скидки недели',
  'Макияж',
  'Для него',
];
const PLACEMENTS = ['home', 'catalog', 'product', 'cart'] as const;

const editor = await login('mock-editor');
const publisher = await login('mock-publisher');
const count = Number(process.env.DEMO_GROUPS ?? 8);
const now = Date.now();

for (let i = 0; i < count; i++) {
  const color = COLORS[i % COLORS.length]!;
  const cover = await upload(
    editor,
    await sharp({ create: { width: 512, height: 512, channels: 3, background: color } })
      .jpeg()
      .toBuffer(),
    'cover',
  );
  let group = await api<{ id: string; revision: number }>(editor, 'POST', '/groups', {
    title: TITLES[i % TITLES.length],
    placement: PLACEMENTS[i % PLACEMENTS.length],
    priority: 100 - i,
    startAt: new Date(now - 3600_000).toISOString(),
    endAt: new Date(now + 30 * 86400_000).toISOString(),
    platforms: ['ios', 'android', 'web'],
    coverAssetId: cover,
  });
  for (let s = 0; s < 3; s++) {
    const media = await upload(
      editor,
      await sharp({
        create: {
          width: 1080,
          height: 1920,
          channels: 3,
          background: COLORS[(i + s + 1) % COLORS.length]!,
        },
      })
        .jpeg()
        .toBuffer(),
      'slide',
    );
    group = await api(editor, 'POST', `/groups/${group.id}/slides`, {
      type: 'image',
      mediaAssetId: media,
      durationMs: 5000,
      elements: [
        {
          kind: 'text',
          text: `${TITLES[i % TITLES.length]} · ${s + 1}`,
          style: 'title',
          position: 'top',
        },
      ],
      cta: s === 2 ? { type: 'url', value: 'https://iledebeaute.ru/', label: 'В магазин' } : null,
    });
  }
  group = await api(editor, 'POST', `/groups/${group.id}/submit`, { revision: group.revision });
  await api(publisher, 'POST', `/groups/${group.id}/approve`, { revision: group.revision });
  console.log(`✓ ${TITLES[i % TITLES.length]} (${PLACEMENTS[i % PLACEMENTS.length]})`);
}
