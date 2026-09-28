import { KILL_SWITCH_CONFIRMATION } from '@idb-stories/schema';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ru } from '../../i18n/ru.js';
import { CSRF, SETTINGS, makeMe, mockApi, renderApp } from '../../test/utils.js';

describe('Kill switch', () => {
  it('требует ввести слово подтверждения точно', async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      'GET /admin/v1/auth/me': () => ({ body: makeMe(['admin']) }),
      'GET /admin/v1/settings': () => ({ body: SETTINGS }),
      'PUT /admin/v1/settings/feed-enabled': (req) => ({
        body: { ...SETTINGS, feedEnabled: (req.body as { enabled: boolean }).enabled },
      }),
    });
    renderApp('/settings');

    expect(await screen.findByText(ru.settings.feedOn)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: ru.settings.disable }));

    const dialog = await screen.findByRole('dialog', { name: ru.settings.confirmDisableTitle });
    const input = screen.getByLabelText(ru.settings.confirmPrompt(KILL_SWITCH_CONFIRMATION.disable));
    const confirm = screen.getByRole('button', { name: ru.settings.confirmDisable });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(confirm).toHaveProperty('disabled', true);

    await user.type(input, 'отключить');
    expect(confirm).toHaveProperty('disabled', true);
    await user.clear(input);
    await user.type(input, 'ОТКЛЮЧИ');
    expect(confirm).toHaveProperty('disabled', true);
    await user.type(input, 'Ть');
    expect(confirm).toHaveProperty('disabled', true);
    await user.clear(input);
    await user.type(input, KILL_SWITCH_CONFIRMATION.disable);
    expect(confirm).toHaveProperty('disabled', false);

    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const put = requests.find((r) => r.method === 'PUT');
    expect(put?.body).toEqual({ enabled: false, confirmation: KILL_SWITCH_CONFIRMATION.disable });
    expect(put?.headers.get('X-CSRF-Token')).toBe(CSRF);
    expect(await screen.findAllByText(ru.settings.feedOff)).not.toHaveLength(0);
  });

  it('Escape закрывает окно без запроса', async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      'GET /admin/v1/auth/me': () => ({ body: makeMe(['admin']) }),
      'GET /admin/v1/settings': () => ({ body: { ...SETTINGS, feedEnabled: false } }),
    });
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: ru.settings.enable }));
    expect(await screen.findByRole('dialog', { name: ru.settings.confirmEnableTitle })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('не-администратор видит состояние, но не может переключить', async () => {
    mockApi({
      'GET /admin/v1/auth/me': () => ({ body: makeMe(['editor']) }),
      'GET /admin/v1/settings': () => ({ body: SETTINGS }),
    });
    renderApp('/settings');
    expect(await screen.findByText(ru.settings.feedOn)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ru.settings.disable })).toBeNull();
    expect(screen.getByText(ru.settings.readOnly)).toBeTruthy();
  });
});
