import type { Role } from '@idb-stories/schema';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ru } from '../i18n/ru.js';
import { SETTINGS, makeMe, mockApi, renderApp } from '../test/utils.js';

function setup(roles: Role[], path = '/groups') {
  mockApi({
    'GET /admin/v1/auth/me': () => ({ body: makeMe(roles) }),
    'GET /admin/v1/groups': () => ({ body: { items: [], nextCursor: null } }),
    'GET /admin/v1/settings': () => ({ body: SETTINGS }),
    'GET /admin/v1/users': () => ({ body: { items: [] } }),
    'GET /admin/v1/audit-log': () => ({ body: { items: [], nextCursor: null } }),
  });
  return renderApp(path);
}

async function navLinks(): Promise<string[]> {
  const nav = await screen.findByRole('navigation', { name: ru.nav.label });
  return within(nav)
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');
}

describe('Навигация по правам', () => {
  it('редактор не видит разделов администратора и согласования', async () => {
    setup(['editor']);
    const links = await navLinks();
    expect(links).toContain(ru.nav.groups);
    expect(links).not.toContain(ru.nav.audit);
    expect(links).not.toContain(ru.nav.users);
    expect(links).not.toContain(ru.nav.review);
    // Создание группы доступно редактору.
    expect(await screen.findByRole('link', { name: ru.groups.create })).toBeTruthy();
  });

  it('администратор видит журнал аудита, пользователей и настройки', async () => {
    setup(['admin']);
    const links = await navLinks();
    expect(links).toEqual(expect.arrayContaining([ru.nav.audit, ru.nav.users, ru.nav.settings]));
    expect(links).not.toContain(ru.nav.review);
    expect(screen.queryByRole('link', { name: ru.groups.create })).toBeNull();
  });

  it('публикатор видит очередь согласования', async () => {
    setup(['publisher']);
    const links = await navLinks();
    expect(links).toContain(ru.nav.review);
    expect(links).not.toContain(ru.nav.audit);
  });

  it('прямой переход редактора в раздел администратора — «нет доступа»', async () => {
    setup(['editor'], '/audit');
    expect(await screen.findByText(ru.auth.sectionNoAccess)).toBeTruthy();
  });

  it('пользователь без ролей видит экран «нет доступа»', async () => {
    setup([]);
    expect(await screen.findByRole('heading', { name: ru.auth.noAccessTitle })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('button', { name: ru.nav.logout })).toBeTruthy();
  });
});
