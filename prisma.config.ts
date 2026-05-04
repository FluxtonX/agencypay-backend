import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
  // @ts-ignore — Prisma v7 migrate adapter (type defs lag behind runtime)
  migrations: {
    seed: 'npx ts-node --esm prisma/seed.ts',
    async adapter() {
      const { Pool } = await import('pg');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      return new PrismaPg(pool);
    },
  } as any,
});
