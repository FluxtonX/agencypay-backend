import pg from 'pg';
import 'dotenv/config';
import { parse } from 'pg-connection-string';

async function test() {
  console.log('DATABASE_URL:', process.env.DATABASE_URL);
  
  const config = parse(process.env.DATABASE_URL || '');
  console.log('Original parsed config SSL:', config.ssl);
  
  // Set SSL rejectUnauthorized to false
  config.ssl = { rejectUnauthorized: false };
  
  const pool = new pg.Pool(config as any);
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
