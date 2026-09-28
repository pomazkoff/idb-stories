import { applyGrants, createPrismaClient } from '../index.js';

const url = process.env.DATABASE_URL;
const role = process.env.DB_APP_ROLE ?? 'stories_app';
if (!url) throw new Error('DATABASE_URL не задан');
const prisma = createPrismaClient(url);
try {
  const applied = await applyGrants(prisma, role);
  console.log(
    applied ? `Права для роли ${role} применены` : `Роль ${role} не найдена — права не менялись`,
  );
} finally {
  await prisma.$disconnect();
}
