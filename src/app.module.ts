import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_GUARD } from '@nestjs/core';

// Configuration
import configuration from './config/configuration.js';

// Database
import { DatabaseModule } from './database/database.module.js';

// Auth & Guards
import { AuthModule } from './modules/auth/auth.module.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';

// Health
import { HealthModule } from './modules/health/health.module.js';

// Domain Modules
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PayoutsModule } from './modules/payouts/payouts.module.js';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';
import { IngestionModule } from './modules/ingestion/ingestion.module.js';
import { ComplianceModule } from './modules/compliance/compliance.module.js';
import { OutboxModule } from './modules/outbox/outbox.module.js';

// Integration Modules
import { QuickBooksModule } from './integrations/quickbooks/quickbooks.module.js';
import { PlaidModule } from './integrations/plaid/plaid.module.js';
import { ColumnModule } from './integrations/column/column.module.js';
import { XeroModule } from './integrations/xero/xero.module.js';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Event bus (in-memory; swap to SNS/SQS adapter for production)
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),

    // Database (global)
    DatabaseModule,

    // Authentication
    AuthModule,

    // Health checks
    HealthModule,

    // Core domain modules
    LedgerModule,
    WalletModule,
    PaymentsModule,
    PayoutsModule,
    ReconciliationModule,

    // Event system
    EventsModule,

    // Webhook handlers
    WebhooksModule,

    // Ingestion
    IngestionModule,

    // Compliance
    ComplianceModule,

    // Event Persistence
    OutboxModule,

    // Integrations
    QuickBooksModule,
    PlaidModule,
    ColumnModule,
    XeroModule,
  ],
  providers: [
    // Global JWT guard — all routes require auth unless @Public()
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Global RBAC guard — checks @Roles() decorator if present
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}

