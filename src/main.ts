import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  // Global prefix for all routes
  app.setGlobalPrefix('api/v1');

  // Validation pipe for DTO validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new GlobalExceptionFilter());

  // CORS — supports comma-separated origins in CORS_ORIGIN env var
  const rawCorsOrigin = process.env.CORS_ORIGIN || '*';
  const corsOrigin =
    rawCorsOrigin === '*'
      ? '*'
      : rawCorsOrigin.includes(',')
        ? rawCorsOrigin.split(',').map((o) => o.trim())
        : rawCorsOrigin;
  app.enableCors({
    origin: corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type,Authorization,Idempotency-Key',
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`🚀 AgncyPay Backend running on port ${port}`);
  logger.log(`📋 API available at http://localhost:${port}/api/v1`);
  logger.log(`📒 Ledger: http://localhost:${port}/api/v1/ledger`);
  logger.log(`👛 Wallets: http://localhost:${port}/api/v1/wallets`);
  logger.log(`💰 Payments: http://localhost:${port}/api/v1/payments`);
  logger.log(`🏦 Payouts: http://localhost:${port}/api/v1/payouts`);
  logger.log(`💳 Credit: http://localhost:${port}/api/v1/credit`);
  logger.log(`🔄 Reconciliation: http://localhost:${port}/api/v1/reconciliation`);
  logger.log(`📡 Webhooks: http://localhost:${port}/api/v1/webhooks`);
}

bootstrap();
