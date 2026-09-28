import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ru } from '../../i18n/ru.js';
import { CSRF, EMPTY_PREVIEW, SETTINGS, makeGroup, makeMe, mockApi, renderApp, uuid } from '../../test/utils.js';

const FOUR_EYES = 'Вы правили эту версию — согласовать её должен другой публикатор (правило четырёх глаз)';
const SLIDE = uuid(201);

function inReview(canApprove: boolean) {
  return makeGroup({
    status: 'in_review',
    submittedAt: '2026-09-28T11:00:00.000Z',
    submittedBy: { id: uuid(1), name: 'Лена Ведущая' },
    actions: {
      canEdit: true,
      canSubmit: false,
      canApprove,
      canReject: true,
      canPublish: false,
      canUnpublish: false,
      approveBlockedReason: canApprove ? null : FOUR_EYES,
    },
  });
}

function setup(canApprove: boolean) {
  const group = inReview(canApprove);
  const api = mockApi({
    'GET /admin/v1/auth/me': () => ({ body: makeMe(['editor', 'publisher']) }),
    'GET /admin/v1/settings': () => ({ body: SETTINGS }),
    'GET /admin/v1/segments': () => ({ body: { items: [] } }),
    'GET /admin/v1/groups/:id': () => ({ body: group }),
    'GET /admin/v1/groups/:id/preview': () => ({ body: EMPTY_PREVIEW }),
    'GET /admin/v1/groups/:id/diff': () => ({
      body: {
        baseVersion: 2,
        revision: group.revision,
        changes: [
          { path: 'title', before: 'Старое', after: group.title },
          {
            path: `slides[${SLIDE}].elements`,
            before: [],
            after: [{ kind: 'text', text: 'Новинки сезона', style: 'title', position: 'top' }],
          },
        ],
      },
    }),
    'POST /admin/v1/groups/:id/approve': () => ({ body: { ...group, status: 'published' } }),
    'POST /admin/v1/groups/:id/reject': () => ({ body: { ...group, status: 'rejected' } }),
  });
  renderApp(`/review/${group.id}`);
  return { group, ...api };
}

describe('Экран согласования', () => {
  it('«Одобрить» недоступна автору правки — с причиной (правило четырёх глаз)', async () => {
    setup(false);
    const approve = await screen.findByRole('button', { name: ru.review.approve });
    expect(approve).toHaveProperty('disabled', true);
    const reason = screen.getByText(FOUR_EYES);
    expect(approve.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('показывает diff с человекочитаемыми полями и номерами слайдов', async () => {
    setup(true);
    const table = await screen.findByRole('table', { name: ru.review.diffTitle });
    expect(within(table).getByRole('rowheader', { name: ru.diff.fields.title })).toBeTruthy();
    expect(within(table).getByRole('rowheader', { name: ru.diff.slideField(1, 'тексты') })).toBeTruthy();
    expect(within(table).getByText('«Новинки сезона» (Заголовок, сверху)')).toBeTruthy();
    expect(screen.getByText(ru.review.diffBase(2))).toBeTruthy();
  });

  it('другой публикатор одобряет с текущей ревизией', async () => {
    const user = userEvent.setup();
    const { requests, group } = setup(true);
    const approve = await screen.findByRole('button', { name: ru.review.approve });
    expect(approve).toHaveProperty('disabled', false);
    await user.click(approve);
    expect(await screen.findByText(ru.review.approved)).toBeTruthy();
    const post = requests.find((r) => r.path.endsWith('/approve'));
    expect(post?.body).toEqual({ revision: group.revision });
    expect(post?.headers.get('X-CSRF-Token')).toBe(CSRF);
  });

  it('отклонение требует комментарий', async () => {
    const user = userEvent.setup();
    const { requests, group } = setup(false);
    await user.click(await screen.findByRole('button', { name: ru.review.reject }));
    const dialog = await screen.findByRole('dialog', { name: ru.review.rejectTitle });
    await user.click(within(dialog).getByRole('button', { name: ru.review.rejectConfirm }));
    expect(within(dialog).getByRole('alert').textContent).toBe(ru.review.commentRequired);
    expect(requests.some((r) => r.path.endsWith('/reject'))).toBe(false);

    await user.type(within(dialog).getByLabelText(ru.review.rejectComment), 'Поменяйте обложку');
    await user.click(within(dialog).getByRole('button', { name: ru.review.rejectConfirm }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.find((r) => r.path.endsWith('/reject'))?.body).toEqual({
      revision: group.revision,
      comment: 'Поменяйте обложку',
    });
  });
});
