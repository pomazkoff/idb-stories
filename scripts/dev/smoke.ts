/**
 * Смоук-тест живого стенда (pnpm dev:local или docker compose) через настоящий HTTP и S3:
 * вход через mock SSO → presigned-загрузка в quarantine → обработка воркером → группа → согласование
 * другим пользователем → лента и CDN → проверки приватности бакетов и подписи → снятие с публикации.
 *
 *   ADMIN_URL=http://localhost:8081 PUBLIC_URL=http://localhost:8080 S3_URL=http://localhost:9000 pnpm smoke
 */
import assert from 'node:assert/strict';
import { ADMIN, PUBLIC, S3, api, login, sharp, upload } from './client.js';

const step = (name: string) => console.log(`✓ ${name}`);

const editor = await login('mock-editor');
const publisher = await login('mock-publisher');
step('вход через mock SSO: редактор и публикатор');

const slideJpeg = await sharp({
  create: { width: 1080, height: 1920, channels: 3, background: '#c2185b' },
})
  .jpeg()
  .toBuffer();
const coverJpeg = await sharp({
  create: { width: 512, height: 512, channels: 3, background: '#7b1fa2' },
})
  .jpeg()
  .toBuffer();
const slideId = await upload(editor, slideJpeg, 'slide');
const coverId = await upload(editor, coverJpeg, 'cover');
step('presigned-загрузка, воркер, подписанные превью, закрытый bucket media');

const placement = 'catalog';
const now = Date.now();
let group = await api<{ id: string; revision: number }>(editor, 'POST', '/groups', {
  title: `Смоук ${new Date(now).toISOString().slice(11, 19)}`,
  placement,
  priority: 1000,
  startAt: new Date(now - 60_000).toISOString(),
  endAt: new Date(now + 3600_000).toISOString(),
  platforms: ['web'],
  coverAssetId: coverId,
});
group = await api(editor, 'POST', `/groups/${group.id}/slides`, {
  type: 'image',
  mediaAssetId: slideId,
  durationMs: 5000,
  elements: [{ kind: 'text', text: '<script>alert(1)</script>', style: 'title', position: 'top' }],
  cta: { type: 'url', value: 'https://iledebeaute.ru/sale', label: 'Купить' },
});
group = await api(editor, 'POST', `/groups/${group.id}/submit`, { revision: group.revision });
step('группа создана и отправлена на согласование');

const own = await fetch(`${ADMIN}/admin/v1/groups/${group.id}/approve`, {
  method: 'POST',
  headers: {
    cookie: editor.cookie,
    'x-csrf-token': editor.csrf,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ revision: group.revision }),
});
assert.equal(own.status, 403, 'редактор смог согласовать');
await api(publisher, 'POST', `/groups/${group.id}/approve`, { revision: group.revision });
step('согласование: автор не может, публикатор может');

const feed = async () =>
  (await (
    await fetch(`${PUBLIC}/v1/feed?placement=${placement}`, { headers: { 'x-platform': 'web' } })
  ).json()) as {
    groups: { id: string; cover: { url: string }; slides: { elements: { text: string }[] }[] }[];
  };
const published = (await feed()).groups.find((g) => g.id === group.id);
assert.ok(published, 'группы нет в ленте');
assert.equal(published.slides[0]!.elements[0]!.text, '<script>alert(1)</script>');
const cdn = await fetch(published.cover.url);
assert.equal(cdn.status, 200, 'обложка недоступна с CDN');
assert.equal(cdn.headers.get('content-type'), 'image/webp');
assert.ok(published.cover.url.startsWith(S3), 'медиа не с CDN-хоста');
step('группа в ленте, медиа отдаются с «CDN», текст — как есть');

await api(publisher, 'POST', `/groups/${group.id}/unpublish`, { reason: 'смоук' });
assert.ok(!(await feed()).groups.some((g) => g.id === group.id), 'группа не исчезла после снятия');
step('снятие с публикации применяется сразу');
console.log('Смоук-тест пройден');
