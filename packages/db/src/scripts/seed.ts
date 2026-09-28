import { createPrismaClient, seedDevUsers, seedReferenceData } from '../index.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
const prisma = createPrismaClient(url);
try {
  await seedReferenceData(prisma);
  if (process.env.NODE_ENV !== 'production' && process.env.SEED_DEV_USERS !== 'false') {
    await seedDevUsers(prisma);
    console.log('Seed: справочники и dev-пользователи mock-IdP');
  } else {
    console.log('Seed: справочники');
  }
} finally {
  await prisma.$disconnect();
}
