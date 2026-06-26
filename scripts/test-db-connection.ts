import pg from 'pg';
import 'dotenv/config';
import { parse } from 'pg-connection-string';

async function test() {
  const config = parse(process.env.DATABASE_URL || '');
  config.ssl = { rejectUnauthorized: false };
  
  const pool = new pg.Pool(config as any);
  
  try {
    const client = await pool.connect();
    console.log('SUCCESS connecting with pg');
    
    const usersCount = await client.query('SELECT COUNT(*) FROM "User"');
    console.log('Users count:', usersCount.rows[0]);
    
    const walletsCount = await client.query('SELECT COUNT(*) FROM "Wallet"');
    console.log('Wallets count:', walletsCount.rows[0]);
    
    if (parseInt(usersCount.rows[0].count, 10) > 0) {
      const users = await client.query('SELECT id, email, "fullName", role, "walletId" FROM "User" LIMIT 5');
      console.log('Sample Users:', users.rows);
    }
    
    client.release();
  } catch (err) {
    console.error('FAIL:', err);
  } finally {
    await pool.end();
  }
}

test();
