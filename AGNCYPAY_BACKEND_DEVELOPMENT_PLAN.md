# AgncyPay Backend Development Plan

## 1. System Architecture Overview

AgncyPay is a ledger-first, compliance-aware embedded payment orchestration backend. The application is a NestJS modular monolith backed by PostgreSQL and Prisma, with internal domain events used for isolation between modules. External providers are integrated behind explicit adapter boundaries.

### High-Level Components

- **API Layer**: NestJS controllers for invoices, payments, wallets, payouts, compliance, webhooks, health, and admin operations.
- **Application Services**: Use-case orchestration services that validate commands, call domain services, enforce idempotency, and emit events.
- **Ledger Core**: The single source of truth for balances. Every movement of money creates balanced double-entry ledger transactions.
- **Wallet Layer**: User-facing wallet views derived from ledger balances. Wallet rows do not store balances.
- **Bank Adapter Layer**: Provider-neutral bank movement API. Column is the first implementation.
- **Compliance and Risk Layer**: Internal ownership of KYC, KYB, AML, OFAC, sanctions, adverse media, transaction monitoring, and fraud decisions. Alloy, Plaid, and Sardine are tools, not sources of responsibility.
- **Ingestion Layer**: QuickBooks invoice ingestion, deduplication, normalization, and mapping into AgncyPay invoices.
- **Event System**: In-process event bus now, persisted outbox for durability, AWS SQS/SNS/EventBridge compatible later.
- **Reconciliation Layer**: Compares ledger, provider state, bank statements, and expected settlement/payout records.

### Module Interaction Model

1. Controllers receive commands and pass them to application services.
2. Application services run through `IdempotencyService.execute()`.
3. Domain services validate state, compliance, and risk requirements.
4. Any money movement goes through `LedgerService.postTransaction()`.
5. External money movement goes through `BankAdapter`.
6. Domain events are written to the outbox in the same database transaction as state changes.
7. Event consumers perform follow-up work such as split allocation, reconciliation scheduling, compliance screening, and notifications.

Hard rule: no module updates wallet balances directly because wallet balances are computed from ledger entries.

## 2. Module Breakdown

## Wallet Module

### Responsibilities

- Create and manage participant wallets.
- Expose available, pending, and held balances derived from ledger accounts.
- Support wallet holds, releases, and controlled negative balance policy checks.
- Provide wallet statements from ledger transactions.

### Key Services

- `WalletService`
- `WalletBalanceService`
- `WalletStatementService`
- `WalletHoldService`

### Key Methods

- `createWallet(ownerType, ownerId, currency): Promise<Wallet>`
- `getWallet(walletId): Promise<Wallet>`
- `getBalances(walletId): Promise<WalletBalanceView>`
- `getAvailableBalance(walletId, currency): Promise<Money>`
- `getStatement(walletId, filters): Promise<WalletStatement>`
- `placeHold(walletId, amount, reason, idempotencyKey): Promise<WalletHold>`
- `releaseHold(holdId, idempotencyKey): Promise<WalletHold>`
- `assertCanDebit(walletId, amount, options): Promise<void>`

### Dependencies

- `LedgerModule`
- `IdempotencyModule`
- `EventSystemModule`
- `ComplianceModule` for wallet activation rules

## Ledger Module

### Responsibilities

- Enforce double-entry accounting.
- Own ledger accounts, transactions, and entries.
- Compute balances from posted entries.
- Prevent imbalanced or invalid transactions.
- Provide immutable audit trail and correction/reversal mechanics.

### Key Services

- `LedgerService`
- `LedgerAccountService`
- `LedgerBalanceService`
- `LedgerTransactionValidator`
- `LedgerReversalService`

### Key Methods

- `createAccount(input): Promise<LedgerAccount>`
- `postTransaction(command, tx?: PrismaTransaction): Promise<LedgerTransaction>`
- `reverseTransaction(transactionId, reason, idempotencyKey): Promise<LedgerTransaction>`
- `getAccountBalance(accountId, asOf?: Date): Promise<Money>`
- `getWalletBalance(walletId, balanceType): Promise<Money>`
- `assertBalanced(entries): void`
- `assertCurrencyHomogeneous(entries): void`

### Dependencies

- `IdempotencyModule`
- `EventSystemModule`
- Prisma transaction client

## Payment Module

### Responsibilities

- Model incoming brand payments against invoices.
- Track payment lifecycle from initiated to settled.
- Handle partial payments and overpayment rules.
- Trigger split allocation after confirmed settlement or configured prefunding.
- Consume Column payment webhooks.

### Key Services

- `PaymentService`
- `PaymentIntentService`
- `PaymentWebhookService`
- `PaymentSettlementService`

### Key Methods

- `createPaymentIntent(invoiceId, amount, source, idempotencyKey): Promise<PaymentIntent>`
- `markPaymentProcessing(providerRef, event): Promise<void>`
- `markPaymentSettled(providerRef, settledAmount, settledAt): Promise<void>`
- `applyPaymentToInvoice(paymentId): Promise<void>`
- `handlePartialPayment(paymentId): Promise<void>`
- `voidPaymentIntent(paymentIntentId, reason): Promise<void>`

### Dependencies

- `LedgerModule`
- `BankAdapterModule`
- `SplitEngineModule`
- `IngestionModule`
- `RiskFraudModule`
- `ComplianceModule`
- `IdempotencyModule`
- `EventSystemModule`

## Payout Module

### Responsibilities

- Initiate withdrawals from participant wallets to linked bank accounts.
- Enforce payout state machine.
- Place wallet holds before external transfer submission.
- Debit wallet only through ledger transactions.
- Handle payout failures, reversals, and ACH returns.

### Key Services

- `PayoutService`
- `PayoutStateMachine`
- `PayoutWebhookService`
- `PayoutReturnService`
- `PayoutHoldService`

### Key Methods

- `requestPayout(walletId, bankAccountId, amount, idempotencyKey): Promise<Payout>`
- `approvePayout(payoutId): Promise<Payout>`
- `submitPayout(payoutId): Promise<Payout>`
- `markPayoutProcessing(providerTransferId): Promise<void>`
- `markPayoutSucceeded(providerTransferId, effectiveAt): Promise<void>`
- `markPayoutFailed(providerTransferId, reason): Promise<void>`
- `handleAchReturn(providerTransferId, returnCode, returnedAt): Promise<void>`
- `cancelPayout(payoutId, reason): Promise<void>`

### Dependencies

- `WalletModule`
- `LedgerModule`
- `BankAdapterModule`
- `ComplianceModule`
- `RiskFraudModule`
- `IdempotencyModule`
- `EventSystemModule`

## Split Engine Module

### Responsibilities

- Convert invoice split rules into ledger allocations.
- Validate split totals, percentages, fixed amounts, caps, minimums, and rounding.
- Support split templates per agency, brand, or deal.
- Create payable allocation records before ledger posting.

### Key Services

- `SplitEngineService`
- `SplitRuleService`
- `SplitAllocationService`
- `SplitRoundingService`

### Key Methods

- `calculateSplits(invoiceId, paidAmount): Promise<SplitCalculation>`
- `validateSplitRules(invoiceId): Promise<void>`
- `createAllocations(paymentId, calculation, idempotencyKey): Promise<SplitAllocation[]>`
- `postWalletAllocations(paymentId, allocations): Promise<LedgerTransaction>`
- `recalculateForPartialPayment(invoiceId, paidAmount): Promise<SplitCalculation>`

### Dependencies

- `LedgerModule`
- `WalletModule`
- `PaymentModule`
- `IdempotencyModule`
- `EventSystemModule`

## Ingestion Module - QuickBooks

### Responsibilities

- Ingest invoices from QuickBooks.
- Deduplicate external invoices.
- Normalize invoice, customer, line item, and split metadata.
- Track sync state and external mappings.
- Emit events for invoice created, updated, voided, or paid externally.

### Key Services

- `QuickBooksIngestionService`
- `InvoiceIngestionService`
- `ExternalMappingService`
- `InvoiceNormalizationService`
- `IngestionWebhookService`

### Key Methods

- `syncInvoices(connectionId, cursor): Promise<SyncResult>`
- `ingestInvoice(connectionId, externalInvoice): Promise<Invoice>`
- `upsertExternalMapping(provider, externalId, internalType, internalId): Promise<ExternalMapping>`
- `detectDuplicateInvoice(input): Promise<Invoice | null>`
- `normalizeQuickBooksInvoice(raw): Promise<NormalizedInvoice>`
- `markInvoiceVoided(externalInvoiceId): Promise<void>`

### Dependencies

- `PaymentModule`
- `SplitEngineModule`
- `IdempotencyModule`
- `EventSystemModule`

## Compliance Module

### Responsibilities

- Own internal compliance decisions and audit trail.
- Run KYC/KYB through Alloy.
- Run OFAC and sanctions checks.
- Enforce account and transaction restrictions.
- Maintain compliance cases, reviews, evidence, and policy versions.

### Key Services

- `ComplianceService`
- `KycService`
- `KybService`
- `AmlScreeningService`
- `OfacScreeningService`
- `ComplianceCaseService`
- `ComplianceDecisionService`

### Key Methods

- `startKyc(userId, idempotencyKey): Promise<ComplianceCheck>`
- `startKyb(businessId, idempotencyKey): Promise<ComplianceCheck>`
- `screenCounterparty(counterpartyId, context): Promise<ScreeningResult>`
- `screenTransaction(transactionContext): Promise<ComplianceDecision>`
- `assertWalletCanReceive(walletId, amount): Promise<void>`
- `assertWalletCanPayout(walletId, amount): Promise<void>`
- `createCase(subjectId, reason, severity): Promise<ComplianceCase>`
- `applyRestriction(subjectId, restrictionType, reason): Promise<void>`

### Dependencies

- Alloy client
- `RiskFraudModule`
- `WalletModule`
- `EventSystemModule`

## Risk/Fraud Module

### Responsibilities

- Run fraud checks through Sardine.
- Maintain internal risk scores, velocity limits, and rule decisions.
- Evaluate inbound payments, wallet allocation, payout requests, and bank account changes.
- Produce block, review, allow, or hold decisions.

### Key Services

- `RiskService`
- `FraudDecisionService`
- `VelocityLimitService`
- `SardineService`
- `RiskRuleEngine`

### Key Methods

- `evaluatePaymentIntent(input): Promise<RiskDecision>`
- `evaluatePayoutRequest(input): Promise<RiskDecision>`
- `evaluateBankAccountLink(input): Promise<RiskDecision>`
- `recordRiskSignal(subjectId, signal): Promise<void>`
- `assertAllowed(decision): void`
- `refreshVelocityCounters(subjectId, event): Promise<void>`

### Dependencies

- Sardine client
- `ComplianceModule`
- `LedgerModule` for historical movement views
- `EventSystemModule`

## Bank Adapter Module

### Responsibilities

- Provide provider-neutral bank movement interfaces.
- Encapsulate Column API details.
- Normalize provider webhooks into internal events.
- Support future rails and providers without leaking provider types into domain modules.

### Key Services

- `BankAdapterRegistry`
- `ColumnBankAdapter`
- `BankWebhookNormalizer`
- `BankAccountLinkService`

### Key Methods

- `getAdapter(provider): BankAdapter`
- `createIncomingPayment(input): Promise<BankPaymentResult>`
- `createOutgoingTransfer(input): Promise<BankTransferResult>`
- `getTransfer(providerTransferId): Promise<BankTransferStatus>`
- `cancelTransfer(providerTransferId): Promise<CancelTransferResult>`
- `normalizeWebhook(provider, payload, headers): Promise<BankWebhookEvent>`

### Dependencies

- Column client
- Plaid client for bank account verification and linking
- `IdempotencyModule`
- `EventSystemModule`

## Reconciliation Module

### Responsibilities

- Reconcile internal ledger transactions against Column transfers, bank statements, and expected settlement records.
- Detect missing webhooks, duplicate provider events, amount mismatches, wrong states, and orphan ledger entries.
- Create reconciliation exceptions and operational tasks.

### Key Services

- `ReconciliationService`
- `ColumnReconciliationService`
- `LedgerReconciliationService`
- `ReconciliationExceptionService`
- `StatementImportService`

### Key Methods

- `runDailyReconciliation(date): Promise<ReconciliationRun>`
- `reconcilePayment(paymentId): Promise<ReconciliationResult>`
- `reconcilePayout(payoutId): Promise<ReconciliationResult>`
- `compareLedgerToProvider(reference): Promise<ReconciliationDiff[]>`
- `createException(diff): Promise<ReconciliationException>`
- `resolveException(exceptionId, resolution): Promise<void>`

### Dependencies

- `LedgerModule`
- `PaymentModule`
- `PayoutModule`
- `BankAdapterModule`
- `EventSystemModule`

## Idempotency Module

### Responsibilities

- Store idempotency keys, operation fingerprints, request state, responses, and errors.
- Prevent duplicate command execution.
- Support safe retries for API commands, webhooks, ingestion, ledger postings, and provider calls.

### Key Services

- `IdempotencyService`
- `OperationFingerprintService`
- `IdempotencyCleanupService`

### Key Methods

- `execute<T>(scope, key, fingerprint, handler): Promise<T>`
- `reserveKey(scope, key, fingerprint): Promise<IdempotencyRecord>`
- `complete(recordId, response): Promise<void>`
- `fail(recordId, error, retryable): Promise<void>`
- `getExistingResult(scope, key, fingerprint): Promise<unknown>`

### Dependencies

- Prisma transaction client

## Event System Module

### Responsibilities

- Emit domain events from transactional application code.
- Persist events in an outbox table atomically with state changes.
- Dispatch events to in-process consumers now and queues later.
- Track retries, dead-letter state, and consumer idempotency.

### Key Services

- `DomainEventBus`
- `OutboxService`
- `OutboxDispatcher`
- `EventConsumerRegistry`
- `ConsumerCheckpointService`

### Key Methods

- `emit(event, tx?: PrismaTransaction): Promise<void>`
- `emitMany(events, tx?: PrismaTransaction): Promise<void>`
- `dispatchPending(limit): Promise<void>`
- `registerConsumer(eventName, handler): void`
- `markDelivered(outboxEventId, consumerName): Promise<void>`
- `markFailed(outboxEventId, consumerName, error): Promise<void>`

### Dependencies

- Prisma transaction client
- Future AWS SQS/SNS/EventBridge integration

## 3. Database Design - Prisma

### Core Tables

#### `users`

- `id`
- `email`
- `name`
- `status`
- `createdAt`
- `updatedAt`

#### `businesses`

- `id`
- `legalName`
- `taxIdEncrypted`
- `status`
- `createdAt`
- `updatedAt`

#### `participants`

- `id`
- `type`: `BRAND`, `AGENCY`, `TALENT`, `VENDOR`
- `userId`
- `businessId`
- `status`
- Unique nullable relationship to either user or business depending on participant type.

#### `wallets`

- `id`
- `ownerType`
- `ownerId`
- `currency`
- `status`: `PENDING_COMPLIANCE`, `ACTIVE`, `FROZEN`, `CLOSED`
- `createdAt`
- `updatedAt`

Constraint: no balance column. Unique index on `(ownerType, ownerId, currency)`.

#### `ledger_accounts`

- `id`
- `walletId`
- `type`: `ASSET`, `LIABILITY`, `REVENUE`, `EXPENSE`, `EQUITY`
- `subtype`: `CASH_AT_BANK`, `USER_WALLET_PAYABLE`, `PENDING_SETTLEMENT`, `PAYOUT_CLEARING`, `FEE_REVENUE`, `LOSS_RECOVERY`, `ACH_RETURN_RECEIVABLE`
- `currency`
- `normalBalance`: `DEBIT` or `CREDIT`
- `status`
- `createdAt`
- `updatedAt`

Constraint: wallet liability accounts reference wallet. Platform operational accounts do not.

#### `ledger_transactions`

- `id`
- `type`
- `status`: `POSTED`, `REVERSED`
- `referenceType`
- `referenceId`
- `idempotencyKey`
- `description`
- `postedAt`
- `reversedByTransactionId`
- `createdAt`

Constraint: unique `(type, idempotencyKey)`. Posted transactions are immutable.

#### `ledger_entries`

- `id`
- `transactionId`
- `accountId`
- `direction`: `DEBIT`, `CREDIT`
- `amountMinor`
- `currency`
- `createdAt`

Constraints:

- `amountMinor > 0`
- Transaction entries must balance by currency.
- Currency must match ledger account currency.
- Minimum two entries per transaction.
- No updates after posting.

Database cannot fully enforce balanced multi-row entries with standard constraints, so `LedgerService.postTransaction()` must run inside a database transaction and validate before commit. A deferred database trigger can be added later for defense in depth.

#### `external_connections`

- `id`
- `provider`: `QUICKBOOKS`, `PLAID`, `ALLOY`, `SARDINE`, `COLUMN`
- `ownerType`
- `ownerId`
- `status`
- `accessTokenEncrypted`
- `refreshTokenEncrypted`
- `metadata`
- `createdAt`
- `updatedAt`

#### `external_mappings`

- `id`
- `provider`
- `externalId`
- `internalType`
- `internalId`
- `connectionId`
- `metadata`
- `createdAt`

Constraint: unique `(provider, externalId, connectionId)`.

### Invoice and Payment Tables

#### `invoices`

- `id`
- `brandParticipantId`
- `source`: `QUICKBOOKS`, `API`, `MANUAL`
- `externalInvoiceNumber`
- `currency`
- `amountMinor`
- `amountPaidMinor`
- `status`: `DRAFT`, `OPEN`, `PARTIALLY_PAID`, `PAID`, `VOIDED`, `UNCOLLECTIBLE`
- `dueDate`
- `metadata`
- `createdAt`
- `updatedAt`

Constraint: unique `(source, externalInvoiceNumber, brandParticipantId)` where external number is present.

#### `invoice_line_items`

- `id`
- `invoiceId`
- `description`
- `amountMinor`
- `metadata`

#### `payment_intents`

- `id`
- `invoiceId`
- `amountMinor`
- `currency`
- `provider`
- `providerPaymentId`
- `status`: `CREATED`, `REQUIRES_ACTION`, `PROCESSING`, `SETTLED`, `FAILED`, `CANCELED`
- `idempotencyKey`
- `metadata`
- `createdAt`
- `updatedAt`

Constraint: unique `(provider, providerPaymentId)`, unique `idempotencyKey`.

#### `payments`

- `id`
- `paymentIntentId`
- `invoiceId`
- `amountMinor`
- `settledAmountMinor`
- `currency`
- `status`: `PENDING`, `PROCESSING`, `SETTLED`, `FAILED`, `RETURNED`
- `settledAt`
- `ledgerTransactionId`
- `createdAt`
- `updatedAt`

### Split Tables

#### `split_rules`

- `id`
- `invoiceId`
- `participantId`
- `walletId`
- `type`: `PERCENTAGE`, `FIXED`
- `value`
- `priority`
- `capAmountMinor`
- `minimumAmountMinor`
- `createdAt`

#### `split_allocations`

- `id`
- `paymentId`
- `invoiceId`
- `participantId`
- `walletId`
- `amountMinor`
- `currency`
- `status`: `CALCULATED`, `POSTED`, `REVERSED`
- `ledgerTransactionId`
- `createdAt`

Constraint: unique `(paymentId, walletId, participantId)`.

### Payout Tables

#### `bank_accounts`

- `id`
- `ownerType`
- `ownerId`
- `provider`
- `providerBankAccountId`
- `plaidAccountId`
- `mask`
- `routingNumberEncrypted`
- `accountNumberEncrypted`
- `status`: `PENDING_VERIFICATION`, `VERIFIED`, `DISABLED`
- `createdAt`
- `updatedAt`

#### `payouts`

- `id`
- `walletId`
- `bankAccountId`
- `amountMinor`
- `currency`
- `status`: `REQUESTED`, `RISK_REVIEW`, `APPROVED`, `HELD`, `SUBMITTED`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `RETURNED`, `CANCELED`
- `provider`
- `providerTransferId`
- `holdLedgerTransactionId`
- `debitLedgerTransactionId`
- `returnLedgerTransactionId`
- `idempotencyKey`
- `failureReason`
- `returnCode`
- `createdAt`
- `updatedAt`

Constraint: unique `idempotencyKey`, unique nullable `(provider, providerTransferId)`.

#### `wallet_holds`

- `id`
- `walletId`
- `amountMinor`
- `currency`
- `reason`
- `status`: `ACTIVE`, `RELEASED`, `CAPTURED`
- `ledgerTransactionId`
- `createdAt`
- `releasedAt`

### Compliance and Risk Tables

#### `compliance_profiles`

- `id`
- `subjectType`
- `subjectId`
- `status`: `NOT_STARTED`, `PENDING`, `APPROVED`, `REJECTED`, `REVIEW_REQUIRED`, `RESTRICTED`
- `riskTier`
- `createdAt`
- `updatedAt`

#### `compliance_checks`

- `id`
- `profileId`
- `type`: `KYC`, `KYB`, `OFAC`, `SANCTIONS`, `AML_TRANSACTION_MONITORING`
- `provider`
- `providerCheckId`
- `status`
- `result`
- `policyVersion`
- `createdAt`
- `completedAt`

#### `compliance_cases`

- `id`
- `subjectType`
- `subjectId`
- `status`
- `severity`
- `reason`
- `assignedTo`
- `createdAt`
- `closedAt`

#### `risk_decisions`

- `id`
- `subjectType`
- `subjectId`
- `operationType`
- `operationId`
- `decision`: `ALLOW`, `BLOCK`, `REVIEW`, `HOLD`
- `score`
- `rules`
- `provider`
- `providerDecisionId`
- `createdAt`

### Reconciliation and Operations Tables

#### `reconciliation_runs`

- `id`
- `type`
- `date`
- `status`
- `startedAt`
- `completedAt`
- `summary`

#### `reconciliation_items`

- `id`
- `runId`
- `referenceType`
- `referenceId`
- `provider`
- `providerReference`
- `expectedAmountMinor`
- `actualAmountMinor`
- `currency`
- `status`: `MATCHED`, `MISSING_INTERNAL`, `MISSING_PROVIDER`, `AMOUNT_MISMATCH`, `STATE_MISMATCH`
- `details`

#### `reconciliation_exceptions`

- `id`
- `itemId`
- `status`: `OPEN`, `IN_REVIEW`, `RESOLVED`, `IGNORED`
- `severity`
- `resolution`
- `createdAt`
- `resolvedAt`

### Idempotency and Event Tables

#### `idempotency_records`

- `id`
- `scope`
- `key`
- `fingerprint`
- `status`: `IN_PROGRESS`, `COMPLETED`, `FAILED`
- `response`
- `error`
- `retryable`
- `lockedUntil`
- `createdAt`
- `updatedAt`

Constraint: unique `(scope, key)`.

#### `outbox_events`

- `id`
- `eventName`
- `aggregateType`
- `aggregateId`
- `payload`
- `status`: `PENDING`, `DISPATCHED`, `FAILED`, `DEAD_LETTER`
- `attempts`
- `nextAttemptAt`
- `createdAt`
- `dispatchedAt`

#### `event_deliveries`

- `id`
- `outboxEventId`
- `consumerName`
- `status`
- `attempts`
- `lastError`
- `createdAt`
- `updatedAt`

Constraint: unique `(outboxEventId, consumerName)`.

## 4. Core Flows

## Invoice Ingestion to Payment to Split to Wallet Allocation

1. `QuickBooksIngestionService.syncInvoices()` fetches invoices using the stored QuickBooks cursor.
2. `InvoiceNormalizationService.normalizeQuickBooksInvoice()` converts provider fields into `NormalizedInvoice`.
3. `InvoiceIngestionService.ingestInvoice()` computes a deterministic idempotency key:
   - `qbo:invoice:{connectionId}:{quickbooksInvoiceId}:{syncToken}`
4. `ExternalMappingService` checks whether the invoice was already ingested.
5. If new, the system creates:
   - `invoices`
   - `invoice_line_items`
   - `external_mappings`
   - optional `split_rules` from invoice metadata or agency defaults
6. The ingestion transaction emits `invoice.created` or `invoice.updated`.
7. A brand payment is initiated through `PaymentService.createPaymentIntent()`.
8. `RiskService.evaluatePaymentIntent()` evaluates velocity, brand history, amount, and invoice context.
9. `ComplianceService.screenCounterparty()` checks brand and recipients when required.
10. `BankAdapter.createIncomingPayment()` creates the Column transfer or payment instruction.
11. `payment_intents` and `payments` are created in `PROCESSING`.
12. Column webhook is normalized by `BankWebhookNormalizer`.
13. `PaymentWebhookService.markPaymentSettled()` verifies provider signature, deduplicates event ID, and marks payment `SETTLED`.
14. `LedgerService.postTransaction()` records incoming funds:
    - Debit platform cash or settlement account.
    - Credit pending invoice settlement liability.
15. `PaymentSettlementService.applyPaymentToInvoice()` updates `amountPaidMinor`.
16. If invoice is partially paid, status becomes `PARTIALLY_PAID` and split allocation uses the paid amount.
17. `SplitEngineService.calculateSplits()` calculates participant allocations for the settled amount.
18. `SplitEngineService.createAllocations()` persists allocations.
19. `SplitEngineService.postWalletAllocations()` posts ledger movement:
    - Debit pending invoice settlement liability.
    - Credit each participant wallet payable account.
20. Wallet balances become visible through ledger-derived queries.
21. Events emitted:
    - `payment.settled`
    - `invoice.partially_paid` or `invoice.paid`
    - `split.allocations_created`
    - `wallet.credited`

## Payout Flow With State Machine

Allowed states:

- `REQUESTED -> RISK_REVIEW`
- `REQUESTED -> APPROVED`
- `RISK_REVIEW -> APPROVED`
- `RISK_REVIEW -> CANCELED`
- `APPROVED -> HELD`
- `HELD -> SUBMITTED`
- `SUBMITTED -> PROCESSING`
- `PROCESSING -> SUCCEEDED`
- `PROCESSING -> FAILED`
- `SUCCEEDED -> RETURNED`
- Any pre-submission state may move to `CANCELED`.

Steps:

1. Participant calls `PayoutService.requestPayout(walletId, bankAccountId, amount, idempotencyKey)`.
2. `IdempotencyService.execute('payout.request', key, fingerprint, handler)` wraps the command.
3. `ComplianceService.assertWalletCanPayout()` confirms KYC/KYB, OFAC, sanctions, wallet status, and payout restrictions.
4. `RiskService.evaluatePayoutRequest()` evaluates Sardine result, velocity, account age, recent incoming funds, amount, and device/session risk.
5. `WalletService.assertCanDebit()` computes available balance from ledger entries minus active holds.
6. If review is required, payout is created in `RISK_REVIEW`.
7. If allowed, payout is created in `APPROVED`.
8. `PayoutHoldService` places a ledger hold by moving funds from available wallet payable to held wallet payable:
   - Debit participant wallet payable available.
   - Credit participant wallet payable held.
9. Payout moves to `HELD`.
10. `BankAdapter.createOutgoingTransfer()` submits the ACH transfer to Column with provider idempotency key:
    - `payout:{payoutId}:submit:v1`
11. Payout moves to `SUBMITTED` with `providerTransferId`.
12. Column webhook moves payout to `PROCESSING`.
13. On success, `PayoutService.markPayoutSucceeded()` captures the held funds:
    - Debit participant wallet payable held.
    - Credit platform cash at bank.
14. Payout moves to `SUCCEEDED`.
15. Events emitted:
    - `payout.requested`
    - `payout.approved`
    - `payout.held`
    - `payout.submitted`
    - `payout.succeeded`

## Failed Payout and ACH Return Handling

### Failure Before Funds Leave Bank

1. Column sends failed transfer webhook.
2. `PayoutWebhookService.markPayoutFailed()` deduplicates provider event.
3. Payout state moves from `PROCESSING` or `SUBMITTED` to `FAILED`.
4. Held wallet funds are released:
   - Debit participant wallet payable held.
   - Credit participant wallet payable available.
5. `wallet_hold.status` becomes `RELEASED`.
6. Event emitted: `payout.failed`.

### Failure After Wallet Debit But Before Provider Success

This should be rare if the system only captures held funds on provider success. If an operational bug or provider ambiguity causes a debit before final success:

1. Payout is marked `FAILED_REQUIRES_REVIEW` or remains `PROCESSING` with reconciliation exception.
2. `ReconciliationExceptionService.createException()` opens a high-severity item.
3. If provider confirms no funds moved, post reversal:
   - Debit platform cash at bank.
   - Credit participant wallet payable available.
4. If provider later confirms success, close exception and keep debit.

### ACH Return After Successful Payout

1. Column sends ACH return webhook with return code.
2. `PayoutReturnService.handleAchReturn()` deduplicates by provider event ID and transfer ID.
3. Payout moves from `SUCCEEDED` to `RETURNED`.
4. Ledger posts return transaction:
   - Debit platform cash at bank.
   - Credit participant wallet payable available.
5. If fees are charged:
   - Debit participant wallet payable available or ACH return receivable.
   - Credit platform fee recovery account or platform cash, depending on fee timing.
6. If wallet would go negative due to return fee, apply controlled negative balance only if policy allows:
   - Wallet status remains active with negative available balance, or
   - Restrict wallet and create compliance/risk case.
7. Events emitted:
   - `payout.returned`
   - `wallet.credited`
   - `risk.signal_recorded`

## Reconciliation Flow

1. `ReconciliationService.runDailyReconciliation(date)` starts a run.
2. `ColumnReconciliationService` fetches Column transfers, returns, settlement reports, and balances for the date.
3. `LedgerReconciliationService` loads internal payments, payouts, ledger transactions, and provider references.
4. The reconciler compares:
   - Provider transfer exists for each internal payment/payout.
   - Internal record exists for each provider transfer.
   - Amount, currency, direction, dates, and state match.
   - Ledger transaction exists for every settled payment, succeeded payout, return, and fee.
   - Ledger entries balance by currency.
5. Matched records create `reconciliation_items.status = MATCHED`.
6. Differences create `reconciliation_exceptions`.
7. High-severity exceptions emit `reconciliation.exception_created`.
8. Operations can resolve exceptions with one of:
   - Provider webhook replay
   - Ledger correction transaction
   - Internal state repair
   - Manual write-off with approval
9. Reconciliation never mutates historical ledger entries. It posts correction transactions.

## 5. Ledger Design

## Account Structure

Platform accounts:

- `Cash at Column` - asset, debit normal
- `Pending Invoice Settlement` - liability, credit normal
- `Payout Clearing` - asset or contra-liability depending on settlement model
- `ACH Return Receivable` - asset, debit normal
- `Fee Revenue` - revenue, credit normal
- `Loss Expense` - expense, debit normal

Wallet accounts per wallet:

- `Wallet Payable Available` - liability, credit normal
- `Wallet Payable Held` - liability, credit normal

Optional future scaffold:

- `International Payout Clearing` for future non-US rails. Do not build international payouts in initial phases.
- `Credit Facility Receivable` for future Net-0 or credit products. Do not build in current system.

## Transaction Structure

Each `LedgerTransaction` has:

- Stable type: `INCOMING_PAYMENT_SETTLED`, `SPLIT_ALLOCATION`, `PAYOUT_HOLD_PLACED`, `PAYOUT_CAPTURED`, `PAYOUT_HOLD_RELEASED`, `PAYOUT_RETURNED`, `FEE_CHARGED`, `LEDGER_CORRECTION`
- Reference type and ID.
- Idempotency key.
- Two or more entries.
- Single currency per transaction for Phase 1-5.
- Immutable posted timestamp.

## Entry Rules

- Sum of debits must equal sum of credits per transaction and currency.
- Amounts are integers in minor units.
- No negative entry amounts.
- No direct wallet balance mutation.
- No unposted external money movement.
- Reversals are new transactions, never updates.
- Corrections require reason, actor, and reference.
- Ledger transaction and domain state update happen in one Prisma database transaction whenever possible.

## Example Entries

### Incoming Brand Payment Settled - $10,000

| Account | Direction | Amount |
| --- | --- | ---: |
| Cash at Column | Debit | 1,000,000 |
| Pending Invoice Settlement | Credit | 1,000,000 |

### Split Allocation - Agency $2,000, Talent $7,000, Vendor $1,000

| Account | Direction | Amount |
| --- | --- | ---: |
| Pending Invoice Settlement | Debit | 1,000,000 |
| Agency Wallet Payable Available | Credit | 200,000 |
| Talent Wallet Payable Available | Credit | 700,000 |
| Vendor Wallet Payable Available | Credit | 100,000 |

### Payout Hold - Talent Withdraws $3,000

| Account | Direction | Amount |
| --- | --- | ---: |
| Talent Wallet Payable Available | Debit | 300,000 |
| Talent Wallet Payable Held | Credit | 300,000 |

### Payout Captured on Success

| Account | Direction | Amount |
| --- | --- | ---: |
| Talent Wallet Payable Held | Debit | 300,000 |
| Cash at Column | Credit | 300,000 |

### Payout Failure Before Funds Leave

| Account | Direction | Amount |
| --- | --- | ---: |
| Talent Wallet Payable Held | Debit | 300,000 |
| Talent Wallet Payable Available | Credit | 300,000 |

### ACH Return After Successful Payout

| Account | Direction | Amount |
| --- | --- | ---: |
| Cash at Column | Debit | 300,000 |
| Talent Wallet Payable Available | Credit | 300,000 |

## 6. BankAdapter Design

## Interface

```ts
export interface BankAdapter {
  readonly provider: BankProvider;

  createIncomingPayment(input: CreateIncomingPaymentInput): Promise<BankPaymentResult>;

  createOutgoingTransfer(input: CreateOutgoingTransferInput): Promise<BankTransferResult>;

  getTransfer(input: GetTransferInput): Promise<BankTransferStatus>;

  cancelTransfer(input: CancelTransferInput): Promise<CancelTransferResult>;

  normalizeWebhook(input: NormalizeBankWebhookInput): Promise<BankWebhookEvent>;
}

export type CreateOutgoingTransferInput = {
  idempotencyKey: string;
  amountMinor: number;
  currency: 'USD';
  sourceAccountId: string;
  destinationBankAccountId: string;
  description: string;
  metadata: {
    payoutId: string;
    walletId: string;
  };
};

export type BankTransferResult = {
  provider: BankProvider;
  providerTransferId: string;
  status: 'SUBMITTED' | 'PROCESSING' | 'FAILED';
  raw: unknown;
};
```

## Column Implementation Example

```ts
@Injectable()
export class ColumnBankAdapter implements BankAdapter {
  readonly provider = BankProvider.COLUMN;

  constructor(private readonly columnClient: ColumnClient) {}

  async createOutgoingTransfer(input: CreateOutgoingTransferInput): Promise<BankTransferResult> {
    const transfer = await this.columnClient.transfers.createAchTransfer({
      idempotencyKey: input.idempotencyKey,
      amount: input.amountMinor,
      currencyCode: input.currency,
      sourceAccountId: input.sourceAccountId,
      destinationAccountId: input.destinationBankAccountId,
      description: input.description,
      metadata: input.metadata,
    });

    return {
      provider: BankProvider.COLUMN,
      providerTransferId: transfer.id,
      status: this.mapColumnTransferStatus(transfer.status),
      raw: transfer,
    };
  }

  async normalizeWebhook(input: NormalizeBankWebhookInput): Promise<BankWebhookEvent> {
    const event = this.columnClient.webhooks.verifyAndParse(input.payload, input.headers);

    return {
      provider: BankProvider.COLUMN,
      providerEventId: event.id,
      eventType: this.mapColumnEventType(event.type),
      providerTransferId: event.data.transferId,
      occurredAt: new Date(event.createdAt),
      payload: event,
    };
  }

  private mapColumnTransferStatus(status: string): BankTransferResult['status'] {
    if (status === 'completed') return 'PROCESSING';
    if (status === 'failed') return 'FAILED';
    return 'SUBMITTED';
  }
}
```

Column-specific types remain inside the adapter. Domain modules store normalized provider IDs and statuses only.

## 7. Compliance Hooks

### KYC and KYB

- Trigger on participant onboarding before wallet activation.
- Trigger on material profile changes.
- Required before wallet can receive funds unless policy allows restricted prefunding.
- Required before payout submission.
- Stored in `compliance_checks` with provider evidence and internal decision.

### OFAC and Sanctions Screening

- Trigger on participant creation.
- Trigger before wallet allocation for new recipients.
- Trigger before payout submission.
- Trigger periodically for active participants.
- Trigger on bank account ownership changes.

### Fraud Checks

- Trigger when brand initiates payment.
- Trigger when bank account is linked or changed.
- Trigger when payout is requested.
- Trigger for high-velocity split allocation patterns.
- Trigger on ACH return, failed payment, disputed transaction, or provider risk webhook.

### Transaction Monitoring

- Run after ledger-posted events:
  - `payment.settled`
  - `split.allocations_posted`
  - `payout.requested`
  - `payout.succeeded`
  - `payout.returned`
- Rules include velocity, structuring, unusual recipient graph, rapid withdrawal after funding, repeated returns, and mismatched invoice/payment behavior.

## 8. Idempotency Strategy

## Key Rules

- Every externally reachable command requires an idempotency key.
- Webhooks use provider event ID as the idempotency key.
- Ingestion uses provider object ID plus version/sync token.
- Ledger transactions require operation-specific idempotency keys.
- Provider calls use deterministic idempotency keys derived from internal IDs.
- If the same key is reused with a different fingerprint, return `409 Conflict`.
- If an operation is `IN_PROGRESS`, return `409 In Progress` or wait with a short lock depending on endpoint semantics.
- Completed idempotent requests return the original response.

## Suggested Keys

- Invoice ingestion: `qbo:invoice:{connectionId}:{invoiceId}:{syncToken}`
- Payment intent create: client-provided key scoped to `payment_intent.create`
- Payment webhook: `column:webhook:{eventId}`
- Payment settlement ledger: `ledger:payment_settled:{paymentId}`
- Split allocation: `split:payment:{paymentId}`
- Split ledger posting: `ledger:split_allocation:{paymentId}`
- Payout request: client-provided key scoped to `payout.request`
- Payout hold ledger: `ledger:payout_hold:{payoutId}`
- Payout submit provider call: `column:payout_submit:{payoutId}`
- Payout success ledger: `ledger:payout_capture:{payoutId}`
- Payout failure release: `ledger:payout_release:{payoutId}:{failureEventId}`
- ACH return: `ledger:payout_return:{payoutId}:{returnEventId}`
- Reconciliation run: `recon:{type}:{date}`

## Retry Handling

- Retry provider calls only when provider response is timeout or explicitly retryable.
- Before retrying provider submission, call `getTransfer()` if a provider reference may have been created.
- Do not post a second ledger transaction on retry. Use ledger idempotency keys.
- Outbox consumers must be idempotent and track delivery by `(outboxEventId, consumerName)`.
- Webhook handlers must process out-of-order events by checking state machine transitions.

## 9. Event-Driven Design

### Events Emitted

- `invoice.created`
- `invoice.updated`
- `invoice.voided`
- `payment_intent.created`
- `payment.processing`
- `payment.settled`
- `payment.failed`
- `invoice.partially_paid`
- `invoice.paid`
- `split.allocations_created`
- `split.allocations_posted`
- `wallet.created`
- `wallet.credited`
- `wallet.hold_placed`
- `wallet.hold_released`
- `payout.requested`
- `payout.risk_review_required`
- `payout.approved`
- `payout.held`
- `payout.submitted`
- `payout.processing`
- `payout.succeeded`
- `payout.failed`
- `payout.returned`
- `compliance.check_started`
- `compliance.check_completed`
- `compliance.case_created`
- `risk.decision_created`
- `risk.signal_recorded`
- `reconciliation.run_completed`
- `reconciliation.exception_created`

### Consumers

- `PaymentSettledConsumer`
  - Applies payment to invoice.
  - Triggers split calculation and allocation posting.

- `SplitAllocationsPostedConsumer`
  - Emits wallet credit notifications.
  - Triggers AML transaction monitoring.

- `PayoutRequestedConsumer`
  - Runs risk and compliance review when asynchronous review is needed.

- `PayoutSubmittedConsumer`
  - Schedules provider status polling if webhook is delayed.

- `PayoutReturnedConsumer`
  - Records risk signal.
  - Opens compliance case for repeated returns.

- `ComplianceCheckCompletedConsumer`
  - Activates or restricts wallets based on internal decision.

- `ReconciliationExceptionConsumer`
  - Creates operational review tasks.
  - Escalates high-severity money movement mismatches.

Events are versioned with `eventVersion`. Payloads include `eventId`, `occurredAt`, `aggregateType`, `aggregateId`, `correlationId`, and `causationId`.

## 10. Development Phases

## Phase 1 - Core Ledger and Wallet

Build first:

- Prisma schema for wallets, ledger accounts, ledger transactions, ledger entries, idempotency records, and outbox events.
- `LedgerModule` with strict double-entry validation.
- `WalletModule` with derived balance queries.
- Platform ledger account bootstrap.
- Wallet account creation.
- Ledger reversal support.
- Unit tests for balanced postings, imbalance rejection, currency mismatch, idempotent posting, and derived balances.

Acceptance criteria:

- No wallet balance field exists.
- Impossible to post imbalanced ledger transaction through `LedgerService`.
- Wallet available and held balances are derived from entries.
- Re-running the same ledger command returns the same transaction.

## Phase 2 - Payments and Ingestion

Build:

- `IngestionModule` for QuickBooks invoice sync and deduplication.
- Invoice, line item, external mapping, payment intent, payment, split rule, and split allocation schema.
- `PaymentModule` for payment intent lifecycle.
- `SplitEngineModule` for fixed and percentage splits.
- Payment settlement flow that posts ledger entries.
- Partial payment handling.

Acceptance criteria:

- Duplicate QuickBooks invoices do not create duplicate invoices.
- Partial payments allocate only settled paid amount.
- Split allocations always sum to settled amount.
- Payment settlement creates balanced ledger transactions.

## Phase 3 - Payouts and Bank Integration

Build:

- `BankAdapter` interface.
- `ColumnBankAdapter` for outgoing ACH transfers and webhook normalization.
- Plaid-backed bank account linking scaffold.
- `PayoutModule` state machine.
- Payout hold, submit, success, failure, and cancellation flows.
- Provider webhook idempotency.

Acceptance criteria:

- Payouts cannot bypass compliance, risk, wallet availability, or ledger services.
- Payouts place a hold before provider submission.
- Successful payout captures held balance.
- Failed payout releases held balance.
- Out-of-order webhooks do not corrupt state.

## Phase 4 - Compliance and Reconciliation

Build:

- `ComplianceModule` with Alloy KYC/KYB integration boundary.
- OFAC and sanctions screening service boundaries.
- `RiskFraudModule` with Sardine integration boundary and internal rule engine.
- Compliance cases and restrictions.
- `ReconciliationModule` for daily provider-to-ledger matching.
- ACH return handling.

Acceptance criteria:

- Wallet activation depends on internal compliance decision.
- Payout submission checks KYC/KYB, OFAC, sanctions, and risk.
- ACH return after successful payout restores wallet payable through ledger.
- Reconciliation detects missing provider record, missing internal record, amount mismatch, state mismatch, and missing ledger transaction.

## Phase 5 - Hardening and Edge Cases

Build:

- Deferred ledger balance database trigger or reconciliation assertion job.
- Admin correction workflow with approval.
- Dead-letter handling for outbox events.
- Webhook replay tooling.
- Operational dashboards for payout exceptions, compliance cases, and reconciliation exceptions.
- Controlled negative balance policy.
- Comprehensive integration tests around money movement.
- Audit logging for privileged actions.
- Secrets management and encryption for provider tokens and bank data.

Acceptance criteria:

- Duplicate invoice ingestion, payment webhooks, payout webhooks, and retries are idempotent.
- Ledger imbalance prevention has service-level and database-level defenses.
- ACH returns and payout failures are covered by tests.
- Negative wallet balances are impossible unless explicitly allowed by policy and recorded.
- All money movement has traceable correlation from API request to provider call to ledger transaction.

## Critical Edge Case Handling

### Duplicate Invoice Ingestion

- Unique external mapping and invoice source constraints.
- Idempotency key includes QuickBooks invoice ID and sync token.
- If same invoice version is reprocessed, return existing invoice.
- If updated version arrives, update mutable invoice fields only while invoice is not fully paid or voided.

### Partial Payments

- `invoice.amountPaidMinor` accumulates settled payments.
- Split engine calculates allocation against settled amount, not invoice face value.
- For multiple partial payments, each payment creates its own split allocations.
- Rounding residual goes to configured residual recipient or platform clearing account, never unbalanced entries.

### ACH Return After Payout

- Payout moves `SUCCEEDED -> RETURNED`.
- Ledger credits wallet payable and debits platform cash.
- Return fees post as separate transactions.
- Risk signal and compliance case are created for repeated returns.

### Payout Failure After Debit

- Preferred design avoids this by debiting wallet held funds only on provider success.
- If it occurs, create reconciliation exception and post corrective reversal only after provider state is confirmed.
- Never edit original ledger transaction.

### Ledger Imbalance Prevention

- `LedgerService.assertBalanced()` validates every transaction.
- Prisma transaction wraps transaction and entries.
- Ledger entries are immutable.
- Reconciliation checks aggregate debits and credits daily.
- Add deferred database trigger in hardening phase.

### Idempotent Retries

- API, ingestion, webhook, provider call, and ledger layers each have deterministic idempotency.
- Same key and same fingerprint returns stored result.
- Same key and different fingerprint fails.
- Consumers use event delivery records.

### Controlled Wallet Negative Balances

- Default policy disallows negative available balance.
- Allowed only for configured scenarios such as return fees or operational loss recovery.
- Negative balance requires:
  - explicit policy flag
  - ledger transaction reason
  - risk signal
  - audit log
  - optional wallet restriction

## Non-Goals

- Do not build Net-0 or credit products in the initial system. Keep ledger account naming extensible for a future credit receivable model.
- Do not build international payouts. Keep provider and currency abstractions clean enough to add future non-US rails.
