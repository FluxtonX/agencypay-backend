import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import 'dotenv/config';

const poolOptions: pg.PoolConfig = { connectionString: process.env.DATABASE_URL };
if (process.env.DATABASE_URL?.includes('sslmode=') || process.env.DATABASE_URL?.includes('ssl=')) {
  poolOptions.ssl = { rejectUnauthorized: false };
}
const pool = new pg.Pool(poolOptions);
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🛡️  Adding database-level ledger balancing trigger...');

  const sql = `
    -- 1. Function to validate transaction balance
    CREATE OR REPLACE FUNCTION check_transaction_balance()
    RETURNS TRIGGER AS $$
    DECLARE
      total_sum DECIMAL(19, 4);
    BEGIN
      -- Compute the sum of all entries for this transaction ID
      SELECT SUM(amount) INTO total_sum
      FROM ledger_entries
      WHERE "transactionId" = NEW."transactionId";

      -- If the sum is not zero, the transaction is invalid
      IF total_sum != 0 THEN
        RAISE EXCEPTION 'Ledger transaction % is imbalanced (sum = %)', NEW."transactionId", total_sum;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- 2. Trigger that runs AFTER all entries for a transaction are inserted
    -- Note: This is a DEFERRED constraint trigger to allow multiple inserts in one transaction
    DROP TRIGGER IF EXISTS trg_check_ledger_balance ON ledger_entries;
    
    CREATE CONSTRAINT TRIGGER trg_check_ledger_balance
    AFTER INSERT OR UPDATE ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION check_transaction_balance();
  `;

  try {
    await prisma.$executeRawUnsafe(sql);
    console.log('✅ Ledger balancing trigger successfully created (Deferred Constraint).');
  } catch (error) {
    console.error('❌ Failed to create trigger:', error);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
