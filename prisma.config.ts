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
      const poolOptions: any = { connectionString: process.env.DATABASE_URL };
      if (process.env.DATABASE_URL?.includes('sslmode=') || process.env.DATABASE_URL?.includes('ssl=')) {
        poolOptions.ssl = { rejectUnauthorized: false };
      }
      const pool = new Pool(poolOptions);
      return new PrismaPg(pool);
    },
  } as any,
});
