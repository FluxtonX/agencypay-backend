import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service.js';
import { AgncyPayEvent } from '../../common/constants/events.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Normalized invoice structure from QuickBooks.
 */
export interface NormalizedInvoice {
  externalId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  amount: string;
  currency: string;
  dueDate: string;
  status: string;
  lineItems: {
    description: string;
    amount: string;
    quantity: number;
  }[];
  metadata: Record<string, unknown>;
}

/**
 * QuickBooks webhook event payload.
 */
export interface QuickBooksWebhookEvent {
  eventNotifications: {
    realmId: string;
    dataChangeEvent: {
      entities: {
        name: string; // "Invoice", "Payment"
        id: string;
        operation: 'Create' | 'Update' | 'Delete';
        lastUpdated: string;
      }[];
    };
  }[];
}

/**
 * QuickBooksService — Integration layer for QuickBooks invoice ingestion.
 *
 * Responsibilities:
 * - Parse and validate webhook events
 * - Normalize invoice data to internal schema
 * - Polling fallback for missed webhooks
 * - Deduplication of webhook events
 */
@Injectable()
export class QuickBooksService {
  private readonly logger = new Logger(QuickBooksService.name);
  private readonly processedWebhooks = new Set<string>(); // In-memory dedup for demo; use DB in production

  constructor(
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly authService: QuickBooksAuthService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Handle a QuickBooks webhook event.
   * Validates, deduplicates, and normalizes invoice data.
   */
  async handleWebhook(
    payload: QuickBooksWebhookEvent,
    signature?: string,
  ): Promise<{ processed: number; skipped: number }> {
    // 1. Verify webhook signature (in production)
    if (!this.verifyWebhookSignature(payload, signature)) {
      this.logger.warn('Invalid QuickBooks webhook signature');
      throw new Error('Invalid webhook signature');
    }

    let processed = 0;
    let skipped = 0;

    for (const notification of payload.eventNotifications) {
      const realmId = notification.realmId;

      for (const entity of notification.dataChangeEvent.entities) {
        // 2. Deduplicate
        const dedupeKey = `${realmId}:${entity.name}:${entity.id}:${entity.lastUpdated}`;

        if (this.processedWebhooks.has(dedupeKey)) {
          this.logger.debug(`Duplicate webhook skipped: ${dedupeKey}`);

          this.eventEmitter.emit(AgncyPayEvent.QUICKBOOKS_WEBHOOK_DUPLICATE, {
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            source: 'QuickBooksService',
            dedupeKey,
          });

          skipped++;
          continue;
        }

        // 3. Process based on entity type
        if (entity.name === 'Invoice') {
          await this.processInvoiceEvent(
            realmId,
            entity.id,
            entity.operation,
          );
          processed++;
        } else if (entity.name === 'Payment') {
          await this.processPaymentEvent(
            realmId,
            entity.id,
            entity.operation,
          );
          processed++;
        }

        // Mark as processed
        this.processedWebhooks.add(dedupeKey);

        // Prevent unbounded growth (in production, use DB with TTL)
        if (this.processedWebhooks.size > 10000) {
          const iter = this.processedWebhooks.values();
          this.processedWebhooks.delete(iter.next().value!);
        }
      }
    }

    return { processed, skipped };
  }

  /**
   * Fetch an invoice from QuickBooks API and normalize it.
   * Used for both webhook processing and polling fallback.
   */
  async fetchAndNormalizeInvoice(
    realmId: string,
    invoiceId: string,
  ): Promise<NormalizedInvoice> {
    const baseUrl = this.config.get<string>(
      'QUICKBOOKS_BASE_URL',
      'https://sandbox-quickbooks.api.intuit.com',
    );

    // 1. Resolve connection for this realm
    const connection = await this.prisma.quickBooksConnection.findUnique({
      where: { realmId },
    });

    if (!connection) {
      this.logger.error(`No connection found for realmId: ${realmId}`);
      throw new Error(`Connection not found for realm ${realmId}`);
    }

    // 2. Get valid access token
    const accessToken = await this.authService.getValidToken(
      connection.walletId,
    );

    // 3. Call QuickBooks API
    this.logger.log(`Fetching invoice ${invoiceId} from QuickBooks`);
    const response = await fetch(
      `${baseUrl}/v3/company/${realmId}/invoice/${invoiceId}?minorversion=65`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      },
    );

    const data = await response.json();

    if (!response.ok) {
      this.logger.error(
        `Failed to fetch invoice from QuickBooks: ${JSON.stringify(data)}`,
      );
      throw new Error(`QuickBooks API error: ${response.statusText}`);
    }

    const qbInvoice = data.Invoice;

    // 4. Normalize
    return {
      externalId: qbInvoice.Id,
      invoiceNumber: qbInvoice.DocNumber,
      customerId: qbInvoice.CustomerRef.value,
      customerName: qbInvoice.CustomerRef.name,
      amount: qbInvoice.TotalAmt.toString(),
      currency: qbInvoice.CurrencyRef.value,
      dueDate: qbInvoice.DueDate,
      status: qbInvoice.EmailStatus, // or other status field
      lineItems: qbInvoice.Line.filter((l: any) => l.DetailType === 'SalesItemLineDetail').map(
        (line: any) => ({
          description: line.Description,
          amount: line.Amount.toString(),
          quantity: line.SalesItemLineDetail?.Qty || 1,
        }),
      ),
      metadata: {
        raw: qbInvoice,
      },
    };
  }

  /**
   * Polling fallback — fetch recent invoices.
   * Used to catch invoices missed by webhooks.
   */
  async pollRecentInvoices(
    realmId: string,
    sinceDate?: Date,
  ): Promise<NormalizedInvoice[]> {
    const since = sinceDate || new Date(Date.now() - 24 * 60 * 60 * 1000);

    this.logger.log(
      `[MOCK] Polling invoices for realm ${realmId} since ${since.toISOString()}`,
    );

    // In production, this would query:
    // SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime > '${since.toISOString()}'

    // MOCK: Return empty for now
    return [];
  }

  /**
   * Normalize a raw QuickBooks invoice response to our internal schema.
   */
  normalizeInvoice(rawInvoice: Record<string, unknown>): NormalizedInvoice {
    const invoice = rawInvoice as Record<string, unknown>;

    return {
      externalId: String(invoice.Id || ''),
      invoiceNumber: String(invoice.DocNumber || ''),
      customerId: String(
        (invoice.CustomerRef as Record<string, unknown>)?.value || '',
      ),
      customerName: String(
        (invoice.CustomerRef as Record<string, unknown>)?.name || '',
      ),
      amount: String(invoice.TotalAmt || '0'),
      currency: String(
        (invoice.CurrencyRef as Record<string, unknown>)?.value || 'USD',
      ),
      dueDate: String(invoice.DueDate || ''),
      status: String(invoice.Balance) === '0' ? 'Paid' : 'Open',
      lineItems: ((invoice.Line as Record<string, unknown>[]) || [])
        .filter(
          (line: Record<string, unknown>) =>
            line.DetailType === 'SalesItemLineDetail',
        )
        .map((line: Record<string, unknown>) => ({
          description: String(line.Description || ''),
          amount: String(line.Amount || '0'),
          quantity: Number(
            (line.SalesItemLineDetail as Record<string, unknown>)?.Qty || 1,
          ),
        })),
      metadata: {
        source: 'quickbooks',
        rawId: invoice.Id,
        syncTimestamp: new Date().toISOString(),
      },
    };
  }

  // --- Private helpers ---

  private async processInvoiceEvent(
    realmId: string,
    invoiceId: string,
    operation: string,
  ): Promise<void> {
    const invoice = await this.fetchAndNormalizeInvoice(realmId, invoiceId);

    this.eventEmitter.emit(AgncyPayEvent.QUICKBOOKS_INVOICE_RECEIVED, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'QuickBooksService',
      realmId,
      invoiceId,
      operation,
      invoice,
    });

    this.logger.log(
      `QuickBooks invoice processed: ${invoiceId} (${operation}) — ${invoice.amount} ${invoice.currency}`,
    );
  }

  private async processPaymentEvent(
    realmId: string,
    paymentId: string,
    operation: string,
  ): Promise<void> {
    this.logger.log(
      `QuickBooks payment event: ${paymentId} (${operation}) — realm ${realmId}`,
    );

    // Payment events would trigger PaymentsService.ingestPayment
    // via the event bus (handled in the event consumer)
  }

  private verifyWebhookSignature(
    payload: QuickBooksWebhookEvent,
    signature?: string,
  ): boolean {
    // In production, verify HMAC-SHA256 signature
    // const webhookToken = this.config.get('quickbooks.webhookToken');
    // const hash = crypto.createHmac('sha256', webhookToken)
    //   .update(JSON.stringify(payload))
    //   .digest('base64');
    // return hash === signature;

    // MOCK: Always accept
    return true;
  }
}
