import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import 'dotenv/config';

async function test() {
  console.log('DATABASE_URL:', process.env.DATABASE_URL);
  const poolOptions: pg.PoolConfig = {
    connectionString: process.env.DATABASE_URL,
  };
  if (process.env.DATABASE_URL?.includes('sslmode=') || process.env.DATABASE_URL?.includes('ssl=')) {
    poolOptions.ssl = { rejectUnauthorized: false };
  }
  const pool = new pg.Pool(poolOptions);
  
  try {
    const client = await pool.connect();
    console.log('SUCCESS connecting with pg');
    const res = await client.query('SELECT NOW()');
    console.log('Query result:', res.rows[0]);
    client.release();
  } catch (err) {
    console.error('FAIL connecting with pg:', err);
  } finally {
    await pool.end();
  }
}

test();
