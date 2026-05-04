import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Starting database seed...');

  // 1. Create Platform Wallet
  const platformWallet = await prisma.wallet.upsert({
    where: { id: 'platform-wallet-001' }, // Deterministic ID for reference
    update: {},
    create: {
      id: 'platform-wallet-001',
      type: 'PLATFORM',
      name: 'AgencyPay Platform',
      email: 'ops@agencypay.io',
      status: 'ACTIVE',
    },
  });

  console.log(`✅ Platform Wallet created: ${platformWallet.id}`);

  // 2. Create Core Platform Accounts
  const coreAccounts = [
    { type: 'CASH', currency: 'USD' },
    { type: 'FEE', currency: 'USD' },
    { type: 'RECEIVABLE', currency: 'USD' },
    { type: 'SUSPENSE', currency: 'USD' },
  ];

  for (const account of coreAccounts) {
    await prisma.account.upsert({
      where: {
        walletId_type_currency: {
          walletId: platformWallet.id,
          type: account.type as any,
          currency: account.currency,
        },
      },
      update: {},
      create: {
        walletId: platformWallet.id,
        type: account.type as any,
        currency: account.currency,
      },
    });
    console.log(`✅ Platform ${account.type} account created`);
  }

  console.log('✨ Seed complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
