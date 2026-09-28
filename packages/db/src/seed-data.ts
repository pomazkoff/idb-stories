import { MOCK_SEGMENTS, MOCK_SSO_USERS } from '@idb-stories/adapters';
import type { CtaAllowlist } from '@idb-stories/schema';
import type { PrismaClient, RoleName } from '../generated/client/index.js';

export const SETTING_KEYS = {
  feedEnabled: 'feed_enabled',
  ctaAllowlist: 'cta_allowlist',
} as const;

/** TODO(spec): схема диплинков и домены ИДБ — открытый вопрос №6. */
export const DEFAULT_ALLOWLIST: CtaAllowlist = {
  deeplinkSchemes: ['idb'],
  urlDomains: ['iledebeaute.ru'],
};

const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  editor: 'Редактор: черновики, медиа, отправка на согласование',
  publisher: 'Публикатор: согласование, публикация, снятие с публикации',
  analyst: 'Аналитик: только чтение сторис и статистики',
  admin: 'Администратор: пользователи и роли, allowlist, настройки, kill switch',
};

/** Справочные данные, нужные в любом окружении: роли и настройки по умолчанию. */
export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const [name, description] of Object.entries(ROLE_DESCRIPTIONS) as [RoleName, string][]) {
    await prisma.role.upsert({
      where: { name },
      create: { name, description },
      update: { description },
    });
  }
  await prisma.setting.upsert({
    where: { key: SETTING_KEYS.feedEnabled },
    create: { key: SETTING_KEYS.feedEnabled, value: true },
    update: {},
  });
  await prisma.setting.upsert({
    where: { key: SETTING_KEYS.ctaAllowlist },
    create: { key: SETTING_KEYS.ctaAllowlist, value: { ...DEFAULT_ALLOWLIST } },
    update: {},
  });
}

const DEV_ROLES: Record<string, RoleName[]> = {
  'mock-editor': ['editor'],
  'mock-editor-2': ['editor'],
  'mock-publisher': ['publisher'],
  'mock-editor-publisher': ['editor', 'publisher'],
  'mock-analyst': ['analyst'],
  'mock-admin': ['admin'],
  'mock-newcomer': [],
};

/** Пользователи mock-IdP с ролями и сегменты — только для dev и тестов. */
export async function seedDevUsers(prisma: PrismaClient): Promise<void> {
  for (const u of MOCK_SSO_USERS) {
    const user = await prisma.adminUser.upsert({
      where: { subject: u.subject },
      create: { subject: u.subject, email: u.email, name: u.name },
      update: { email: u.email, name: u.name },
    });
    for (const role of DEV_ROLES[u.subject] ?? []) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId: user.id, role } },
        create: { userId: user.id, role },
        update: {},
      });
    }
  }
  for (const s of MOCK_SEGMENTS) {
    await prisma.segment.upsert({ where: { id: s.id }, create: s, update: { name: s.name } });
  }
}
