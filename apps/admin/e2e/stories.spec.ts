/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * DoD фазы 4 (раздел 13) и приёмка 10.11 на живом стенде:
 * редактор собирает группу (обложка + слайд с текстом и CTA) → медиа обрабатываются → отправка
 * на согласование → другой человек (публикатор) одобряет → группа в публичной ленте → снятие с
 * публикации убирает её из ленты < 60 с. Текст `<script>` везде показывается буквально, JS-диалогов нет.
 */

const PUBLIC_API = process.env.E2E_PUBLIC_API ?? 'http://localhost:8080';
const FIXTURES = {
  cover: fileURLToPath(new URL('./fixtures/cover.png', import.meta.url)),
  slide: fileURLToPath(new URL('./fixtures/slide.jpg', import.meta.url)),
};
const XSS_TEXT = '<script>alert(1)</script>';
const MEDIA_TIMEOUT = 180_000;
const FEED_TIMEOUT = 60_000;

/** Ловим любые alert/confirm/prompt: их появление означает исполнение внедрённого кода. */
function trackDialogs(page: Page): string[] {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return dialogs;
}

async function login(page: Page, subject: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Войти через SSO' }).click();
  // Страница mock-IdP (только dev): сотрудники — кнопки с data-subject.
  await page.locator(`button[data-subject="${subject}"]`).click();
  await expect(page.getByRole('navigation', { name: 'Разделы админки' })).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.waitForURL('**/login');
  await expect(page.getByRole('button', { name: 'Войти через SSO' })).toBeVisible();
}

async function waitMediaReady(page: Page, testId: string) {
  const status = page.getByTestId(testId);
  await expect(status).toHaveAttribute('data-status', /^(ready|rejected)$/, { timeout: MEDIA_TIMEOUT });
  expect(await status.getAttribute('data-status'), `обработка файла (${testId})`).toBe('ready');
}

interface GroupSpec {
  title: string;
  placement: 'home' | 'catalog' | 'product' | 'cart';
  slideText: string;
  cta: { url: string; label: string };
}

/** Создаёт группу через интерфейс: параметры + обложка, затем слайд-изображение с текстом и CTA. */
async function createGroup(page: Page, spec: GroupSpec): Promise<string> {
  await page.getByRole('link', { name: 'Группы', exact: true }).click();
  await page.getByRole('link', { name: 'Создать группу' }).click();
  await page.waitForURL('**/groups/new');

  await page.getByLabel('Название', { exact: true }).fill(spec.title);
  await page.getByLabel('Площадка', { exact: true }).selectOption(spec.placement);
  await page.getByLabel('Приоритет', { exact: true }).fill('1000');
  await page.getByLabel('Файл обложки').setInputFiles(FIXTURES.cover);
  await expect(page.getByTestId('cover-upload-status')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Создать черновик' }).click();

  await page.waitForURL(/\/groups\/[0-9a-f-]{36}$/);
  const groupId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await expect(page.getByRole('heading', { level: 1, name: spec.title })).toBeVisible();

  await page.getByRole('button', { name: 'Добавить изображение' }).click();
  await page.getByLabel('Файл изображения').setInputFiles(FIXTURES.slide);
  await expect(page.getByTestId('slide-media-upload-status')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Добавить текст' }).click();
  await page.getByLabel('Текст 1', { exact: true }).fill(spec.slideText);
  await page.getByLabel('Добавить кнопку CTA').check();
  await page.getByLabel('Тип CTA').selectOption('url');
  await page.getByLabel('Куда ведёт кнопка').fill(spec.cta.url);
  await page.getByLabel('Надпись на кнопке').fill(spec.cta.label);
  await page.getByRole('button', { name: 'Добавить слайд', exact: true }).click();

  const slides = page.getByRole('list', { name: 'Порядок слайдов' });
  await expect(slides.getByText(spec.slideText, { exact: true })).toBeVisible();

  await waitMediaReady(page, 'cover-upload-status');
  await waitMediaReady(page, 'slide-media-upload-status');
  return groupId;
}

async function submitForReview(page: Page) {
  await page.getByRole('button', { name: 'Отправить на согласование' }).click();
  await expect(page.getByText('Группа отправлена на согласование')).toBeVisible();
  await expect(page.locator('.badge', { hasText: 'На согласовании' }).first()).toBeVisible();
}

async function feedGroupIds(request: APIRequestContext, placement: string): Promise<string[]> {
  const res = await request.get(`${PUBLIC_API}/v1/feed?placement=${placement}`, { headers: { 'X-Platform': 'web' } });
  if (res.status() === 204) return [];
  expect(res.ok(), `GET /v1/feed → ${res.status()}`).toBe(true);
  const body = (await res.json()) as { groups?: { id: string }[] };
  return (body.groups ?? []).map((g) => g.id);
}

const uniqueTitle = (prefix: string) => `${prefix} ${Date.now().toString(36)}`;

test('редактор создаёт группу, публикатор согласует, группа в ленте и снимается с публикации', async ({
  page,
  request,
}) => {
  const dialogs = trackDialogs(page);
  const spec: GroupSpec = {
    title: uniqueTitle('E2E'),
    placement: 'cart',
    slideText: XSS_TEXT,
    cta: { url: 'https://iledebeaute.ru/e2e', label: 'Купить' },
  };

  // 1. Редактор: группа с обложкой и слайдом-изображением с CTA.
  await login(page, 'mock-editor');
  const groupId = await createGroup(page, spec);
  // Текст с разметкой показан буквально (и в списке слайдов, и в превью плеера).
  await expect(page.getByText(XSS_TEXT, { exact: true }).first()).toBeVisible();
  await expect(page.locator('script', { hasText: 'alert(1)' })).toHaveCount(0);
  await submitForReview(page);
  await logout(page);

  // 2. Публикатор: diff + превью, одобрение. start_at уже наступил — публикация сразу.
  await login(page, 'mock-publisher');
  await page.getByRole('link', { name: 'Согласование', exact: true }).click();
  await page.getByRole('link', { name: spec.title, exact: true }).click();
  await page.waitForURL(`**/review/${groupId}`);
  await expect(page.getByRole('table', { name: 'Что изменилось' })).toContainText(XSS_TEXT);
  const approve = page.getByRole('button', { name: 'Одобрить', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByText('Группа согласована')).toBeVisible();
  await expect(page.locator('.badge', { hasText: 'Опубликована' }).first()).toBeVisible();

  // 3. Группа в публичной ленте.
  await expect
    .poll(async () => (await feedGroupIds(request, spec.placement)).includes(groupId), {
      timeout: FEED_TIMEOUT,
      intervals: [1_000, 2_000, 5_000],
    })
    .toBe(true);

  // 4. Снятие с публикации — исчезает из ленты не дольше чем за 60 секунд.
  await page.goto(`/groups/${groupId}`);
  await page.getByRole('button', { name: 'Снять с публикации' }).click();
  const dialog = page.getByRole('dialog', { name: 'Снять группу с публикации?' });
  await dialog.getByLabel('Причина (необязательно)').fill('E2E: проверка снятия');
  await dialog.getByRole('button', { name: 'Снять с публикации' }).click();
  await expect(page.getByText('Группа снята с публикации')).toBeVisible();
  const unpublishedAt = Date.now();
  await expect
    .poll(async () => (await feedGroupIds(request, spec.placement)).includes(groupId), {
      timeout: FEED_TIMEOUT,
      intervals: [1_000, 2_000, 5_000],
    })
    .toBe(false);
  expect(Date.now() - unpublishedAt).toBeLessThan(FEED_TIMEOUT);

  // Ни одного JS-диалога: внедрённый код не исполнялся.
  expect(dialogs).toEqual([]);
});

test('автор правки не может согласовать свою группу (правило четырёх глаз)', async ({ page }) => {
  const dialogs = trackDialogs(page);
  const spec: GroupSpec = {
    title: uniqueTitle('E2E 4eyes'),
    placement: 'home',
    slideText: 'Проверка правила четырёх глаз',
    cta: { url: 'https://iledebeaute.ru/e2e-4eyes', label: 'Смотреть' },
  };

  // У пользователя обе роли — редактор и публикатор.
  await login(page, 'mock-editor-publisher');
  const groupId = await createGroup(page, spec);
  await submitForReview(page);

  await page.goto(`/review/${groupId}`);
  const approve = page.getByRole('button', { name: 'Одобрить', exact: true });
  await expect(approve).toBeDisabled();
  await expect(page.getByText(/правило четырёх глаз/)).toBeVisible();

  // Проверка на сервере, а не только в интерфейсе: прямой запрос с CSRF-токеном → 403 four_eyes.
  const direct = await page.evaluate(async (id) => {
    const me = (await (await fetch('/admin/v1/auth/me', { credentials: 'same-origin' })).json()) as { csrfToken: string };
    const group = (await (await fetch(`/admin/v1/groups/${id}`, { credentials: 'same-origin' })).json()) as {
      revision: number;
    };
    const res = await fetch(`/admin/v1/groups/${id}/approve`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken },
      body: JSON.stringify({ revision: group.revision }),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    return { status: res.status, code: body.error?.code };
  }, groupId);
  expect(direct).toEqual({ status: 403, code: 'four_eyes' });

  // Уборка: отклоняем с комментарием (отклонить свою группу можно).
  await page.getByRole('button', { name: 'Отклонить с комментарием' }).click();
  const dialog = page.getByRole('dialog', { name: 'Отклонить группу' });
  await dialog.getByLabel('Комментарий для редактора').fill('E2E: уборка после проверки');
  await dialog.getByRole('button', { name: 'Отклонить', exact: true }).click();
  await expect(page.getByText('Группа отклонена и возвращена редактору')).toBeVisible();

  expect(dialogs).toEqual([]);
});
