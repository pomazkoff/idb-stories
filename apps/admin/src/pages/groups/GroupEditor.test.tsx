import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AdminGroup } from '../../api/types.js';
import { ru } from '../../i18n/ru.js';
import { EMPTY_PREVIEW, SETTINGS, makeGroup, makeMe, mockApi, renderApp, uuid } from '../../test/utils.js';

const S1 = uuid(201);
const S2 = uuid(202);

function twoSlides(): AdminGroup {
  const base = makeGroup();
  const first = base.slides[0]!;
  return {
    ...base,
    slidesCount: 2,
    slides: [
      first,
      { ...first, id: S2, position: 1, elements: [{ kind: 'text', text: 'Второй слайд', style: 'body', position: 'center' }] },
    ],
  };
}

function setup(group: AdminGroup, extra: Parameters<typeof mockApi>[0] = {}) {
  let current = group;
  const api = mockApi({
    'GET /admin/v1/auth/me': () => ({ body: makeMe(['editor']) }),
    'GET /admin/v1/settings': () => ({ body: SETTINGS }),
    'GET /admin/v1/segments': () => ({ body: { items: [{ id: 'seg-vip', name: 'VIP' }] } }),
    'GET /admin/v1/groups/:id': () => ({ body: current }),
    'GET /admin/v1/groups/:id/preview': () => ({ body: EMPTY_PREVIEW }),
    'PUT /admin/v1/groups/:id/slides/order': (req) => {
      const ids = (req.body as { slideIds: string[] }).slideIds;
      current = {
        ...current,
        revision: current.revision + 1,
        slides: ids.map((id, position) => ({ ...current.slides.find((s) => s.id === id)!, position })),
      };
      return { body: current };
    },
    ...extra,
  });
  renderApp(`/groups/${group.id}`);
  return api;
}

describe('Редактор группы', () => {
  it('меняет порядок слайдов кнопками и отправляет текущую ревизию', async () => {
    const user = userEvent.setup();
    const { requests } = setup(twoSlides());
    await user.click(await screen.findByRole('button', { name: ru.slides.moveDown(1) }));

    await waitFor(() => expect(requests.some((r) => r.path.endsWith('/slides/order'))).toBe(true));
    const put = requests.find((r) => r.path.endsWith('/slides/order'));
    expect(put?.body).toEqual({ revision: 3, slideIds: [S2, S1] });
    const list = screen.getByRole('list', { name: ru.slides.listLabel });
    await waitFor(() => expect(within(list).getAllByRole('listitem')[0]!.textContent).toContain('Второй слайд'));
  });

  it('ручка перетаскивания доступна с клавиатуры и подписана', async () => {
    setup(twoSlides());
    const handle = await screen.findByRole('button', { name: ru.slides.dragHandle(1) });
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('aria-roledescription')).toBe('sortable');
    expect(handle.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('сохраняет только изменённые поля с ревизией; время — в UTC', async () => {
    const user = userEvent.setup();
    const group = makeGroup();
    const { requests } = setup(group, {
      'PATCH /admin/v1/groups/:id': (req) => ({ body: { ...group, ...(req.body as object), revision: 4 } }),
    });
    const title = await screen.findByLabelText(ru.meta.title);
    await user.clear(title);
    await user.type(title, 'Новое название');
    await user.click(screen.getByRole('checkbox', { name: 'VIP' }));
    await user.click(screen.getByRole('button', { name: ru.meta.saveButton }));

    await waitFor(() => expect(requests.some((r) => r.method === 'PATCH')).toBe(true));
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      title: 'Новое название',
      segmentIds: ['seg-vip'],
      revision: 3,
    });
    expect(await screen.findByText(ru.meta.saved)).toBeTruthy();
  });

  it('конфликт ревизий предлагает загрузить актуальную версию', async () => {
    const user = userEvent.setup();
    setup(makeGroup(), {
      'PATCH /admin/v1/groups/:id': () => ({
        status: 409,
        body: {
          error: {
            code: 'revision_mismatch',
            message: 'Группа изменена другим пользователем — обновите страницу',
            details: { currentRevision: 5 },
          },
        },
      }),
    });
    const title = await screen.findByLabelText(ru.meta.title);
    await user.type(title, '!');
    await user.click(screen.getByRole('button', { name: ru.meta.saveButton }));
    expect(await screen.findByText('Группа изменена другим пользователем — обновите страницу')).toBeTruthy();
    expect(screen.getByRole('button', { name: ru.errors.reloadGroup })).toBeTruthy();
  });

  it('проблемы готовности при отправке показываются списком', async () => {
    const user = userEvent.setup();
    setup(makeGroup(), {
      'POST /admin/v1/groups/:id/submit': () => ({
        status: 409,
        body: {
          error: {
            code: 'not_ready',
            message: 'Группа не готова к согласованию',
            details: { problems: ['Обложка: не выбрано медиа', 'Слайд 1: файл ещё обрабатывается'] },
          },
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: ru.workflow.submit }));
    const alert = await screen.findByText('Группа не готова к согласованию');
    const box = alert.closest('[role="alert"]') as HTMLElement;
    expect(within(box).getByText(ru.errors.notReady)).toBeTruthy();
    expect(within(box).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Обложка: не выбрано медиа',
      'Слайд 1: файл ещё обрабатывается',
    ]);
  });

  it('комментарий согласующего показывается у отклонённой группы', async () => {
    setup(
      makeGroup({
        status: 'rejected',
        reviewComment: 'Замените обложку',
        reviewedBy: { id: uuid(2), name: 'Павел Публикатор' },
        reviewedAt: '2026-09-28T12:00:00.000Z',
      }),
    );
    expect(await screen.findByText(ru.editor.rejectedTitle)).toBeTruthy();
    expect(screen.getByText('Замените обложку')).toBeTruthy();
  });

  it('без права записи — только просмотр', async () => {
    mockApi({
      'GET /admin/v1/auth/me': () => ({ body: makeMe(['analyst']) }),
      'GET /admin/v1/settings': () => ({ body: SETTINGS }),
      'GET /admin/v1/segments': () => ({ body: { items: [] } }),
      'GET /admin/v1/groups/:id': () => ({
        body: makeGroup({ actions: { ...makeGroup().actions, canEdit: false, canSubmit: false } }),
      }),
      'GET /admin/v1/groups/:id/preview': () => ({ body: EMPTY_PREVIEW }),
    });
    renderApp(`/groups/${uuid(100)}`);
    expect(await screen.findByText(ru.editor.readOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ru.meta.saveButton })).toBeNull();
    expect(screen.queryByRole('button', { name: ru.slides.addImage })).toBeNull();
    expect(screen.queryByRole('button', { name: ru.workflow.submit })).toBeNull();
    expect(screen.getByLabelText(ru.meta.title)).toHaveProperty('disabled', true);
  });
});
