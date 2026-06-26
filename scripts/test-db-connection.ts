import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import 'dotenv/config';
import { parse } from 'pg-connection-string';

async function test() {
  console.log('DATABASE_URL:', process.env.DATABASE_URL);
  
  const parsed = parse(process.env.DATABASE_URL || '');
  console.log('Parsed connection string SSL:', parsed.ssl);
  
  const poolOptions: pg.PoolConfig = {
    connectionString: process.env.DATABASE_URL,
  };
  if (process.env.DATABASE_URL?.includes('sslmode=') || process.env.DATABASE_URL?.includes('ssl=')) {
    poolOptions.ssl = { rejectUnauthorized: false };
  }
  
  // Create pool
  const pool = new pg.Pool(poolOptions);
  console.log('Pool configured SSL:', pool.options.ssl);
  
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
