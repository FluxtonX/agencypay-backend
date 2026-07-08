import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private pool: pg.Pool;
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const poolOptions: pg.PoolConfig = {
      connectionString: process.env.DATABASE_URL,

      // --- Connection Pool Limits (Production-grade) ---
      max: parseInt(process.env.DB_POOL_MAX || '20', 10),
      min: parseInt(process.env.DB_POOL_MIN || '5', 10),
      idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_TIMEOUT || '5000', 10),
      // Statement timeout to kill runaway queries (10s default)
      statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '10000', 10),
    };

    if (process.env.DATABASE_URL?.includes('sslmode=') || process.env.DATABASE_URL?.includes('ssl=')) {
      poolOptions.ssl = { rejectUnauthorized: false };
    }

    const pool = new pg.Pool(poolOptions);

    const adapter = new PrismaPg(pool);

    super({
      adapter,
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'info', 'warn', 'error']
          : ['warn', 'error'],
    });

    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log(
      `Database connected (pool: min=${process.env.DB_POOL_MIN || 5}, max=${process.env.DB_POOL_MAX || 20})`,
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
    this.logger.log('Database disconnected');
  }
}
