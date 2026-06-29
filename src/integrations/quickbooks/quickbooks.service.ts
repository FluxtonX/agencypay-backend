import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgncyPayEvent } from '../../common/constants/events.js';
import { TokenStorageService } from '../token-storage.service.js';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OAuthClient = require('intuit-oauth');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NormalizedInvoice {
  id: string;
  docNumber: string;
  name: string;
  detail: string;
  date: string;
  amount: number;
  status: string;
  daysText: string;
  // Fields needed by ingestion:
  externalId?: string;
  invoiceNumber?: string;
  customerId?: string;
  customerName?: string;
  currency?: string;
  dueDate?: string;
  metadata?: Record<string, any>;
  lineItems?: Array<{ description?: string; amount: number; quantity?: number }>;
}

export interface NormalizedPayout {
  id: string;
  name: string;
  detail: string;
  date: string;
  amount: string;
  fallback: string;
  method: string;
  status: string;
}

export interface QuickBooksWebhookEvent {
  eventNotifications: {
    realmId: string;
    dataChangeEvent: {
      entities: {
        name: string;
        id: string;
        operation: 'Create' | 'Update' | 'Delete';
        lastUpdated: string;
      }[];
    };
  }[];
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

const MOCK_INVOICES: NormalizedInvoice[] = [
  { id: 'mock-1', docNumber: '1', name: 'Amazon Music Unlimited', detail: 'Digital Sales CSV Upload', date: '06/06/2026', amount: 10.29, status: 'Pending', daysText: 'Overdue' },
  { id: 'mock-2', docNumber: '2', name: 'Amazon Prime', detail: 'Digital Sales CSV Upload', date: '06/06/2026', amount: 0.82, status: 'Pending', daysText: '12 days remaining' },
  { id: 'mock-3', docNumber: '3', name: 'Anghami', detail: 'Digital Sales CSV Upload', date: '06/06/2026', amount: 0.01, status: 'Pending', daysText: '47 days remaining' },
  { id: 'mock-4', docNumber: '4', name: 'Apple Music', detail: 'Digital Sales CSV Upload', date: '06/06/2026', amount: 153.76, status: 'Pending', daysText: '78 days remaining' },
  { id: 'mock-5', docNumber: '5', name: 'Audible Magic', detail: 'Digital Sales CSV Upload', date: '06/06/2026', amount: 1.30, status: 'Pending', daysText: '90 days remaining' },
];

const MOCK_PAYOUTS: NormalizedPayout[] = [
  { id: 'payout-mock-1', name: 'Karlos Talent', detail: 'Campaign split payout', date: 'Today, 10:24 AM', amount: '$10,500.00', fallback: 'KT', method: 'Bank Transfer', status: 'Paid' },
  { id: 'payout-mock-2', name: 'Gigi Hadid', detail: 'Paris Fashion Week split', date: 'Today, 9:42 AM', amount: '$9,805.25', fallback: 'GH', method: 'Bank Transfer', status: 'Paid' },
  { id: 'payout-mock-3', name: 'Bella Hadid', detail: 'Talent split payout', date: 'Yesterday', amount: '$3,500.00', fallback: 'BH', method: 'Check', status: 'Paid' },
];

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class QuickBooksService {
  private readonly logger = new Logger(QuickBooksService.name);
  private readonly processedWebhooks = new Set<string>();
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly environment: string;
  private readonly baseUrl: string;
  private readonly redirectUri: string;
  readonly configured: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly tokenStorage: TokenStorageService,
  ) {
    this.clientId = config.get<string>('quickbooks.clientId') || '';
    this.clientSecret = config.get<string>('quickbooks.clientSecret') || '';
    this.environment = config.get<string>('quickbooks.environment') || 'sandbox';
    this.baseUrl = config.get<string>('quickbooks.baseUrl') || 'https://sandbox-quickbooks.api.intuit.com';
    this.redirectUri = config.get<string>('quickbooks.redirectUri') || 'http://localhost:3000/api/auth/quickbooks/callback';
    this.configured = !!(this.clientId && this.clientSecret);
  }

  // ─── OAuth Helpers ────────────────────────────────────────────────────────

  private getOAuthClient(token?: any, redirectUri?: string) {
    const client = new OAuthClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      environment: this.environment,
      redirectUri: redirectUri || this.redirectUri,
    });
    if (token) client.setToken(token);
    return client;
  }

  private async getAuthenticatedClient() {
    const token = this.tokenStorage.getQboToken();
    if (!token) throw new Error('No QuickBooks token found. Please connect to QuickBooks first.');
    if (!this.configured) throw new Error('QuickBooks OAuth is not configured.');

    const oauthClient = this.getOAuthClient(token);

    if (oauthClient.isAccessTokenValid()) return oauthClient;

    this.logger.log('QuickBooks access token expired. Refreshing...');
    try {
      const authResponse = await oauthClient.refresh();
      const newToken = authResponse.getJson();
      if (token.realmId) newToken.realmId = token.realmId;
      this.tokenStorage.saveQboToken(newToken);
      return oauthClient;
    } catch (err) {
      this.logger.error('Failed to refresh QuickBooks token', err);
      throw new Error('Failed to refresh QuickBooks token. Please reconnect.');
    }
  }

  // ─── OAuth Connect ────────────────────────────────────────────────────────

  getConnectUrl(): string {
    if (!this.configured) {
      throw new Error('QuickBooks OAuth is not configured. Set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET.');
    }
    const oauthClient = this.getOAuthClient();
    return oauthClient.authorizeUri({
      scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId, OAuthClient.scopes.Profile, OAuthClient.scopes.Email],
      state: 'agncypay-state',
    });
  }

  // ─── Exchange OAuth Code ──────────────────────────────────────────────────

  async exchangeOAuthCode(callbackUrl: string, realmId?: string): Promise<void> {
    if (!this.configured) throw new Error('QuickBooks OAuth is not configured.');

    let exchangeRedirectUri = this.redirectUri;
    try {
      const parsedUrl = new URL(callbackUrl);
      exchangeRedirectUri = `${parsedUrl.origin}${parsedUrl.pathname}`;
    } catch (err) {
      this.logger.warn('Failed to parse callbackUrl, falling back to default redirectUri', err);
    }

    const oauthClient = this.getOAuthClient(undefined, exchangeRedirectUri);
    const authResponse = await oauthClient.createToken(callbackUrl);
    const tokenData = authResponse.getJson();
    if (realmId) tokenData.realmId = realmId;
    this.tokenStorage.saveQboToken(tokenData);
    this.logger.log('QuickBooks OAuth exchange complete.');
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus(): {
    connected: boolean;
    realmId?: string;
    environment: string;
    connectedAt?: string;
    accessExpiresAt?: string;
    refreshExpiresAt?: string;
    hasRefreshToken?: boolean;
  } {
    const token = this.tokenStorage.getQboToken();
    const env = this.environment;

    if (!token?.access_token) {
      return { connected: false, environment: env };
    }

    const createdAt = token.createdAt || Date.now();
    const accessExpiresAt = token.expires_in ? createdAt + token.expires_in * 1000 : null;
    const refreshExpiresAt = token.x_refresh_token_expires_in ? createdAt + token.x_refresh_token_expires_in * 1000 : null;

    return {
      connected: true,
      realmId: token.realmId,
      environment: env,
      connectedAt: new Date(createdAt).toISOString(),
      accessExpiresAt: accessExpiresAt ? new Date(accessExpiresAt).toISOString() : undefined,
      refreshExpiresAt: refreshExpiresAt ? new Date(refreshExpiresAt).toISOString() : undefined,
      hasRefreshToken: !!token.refresh_token,
    };
  }

  // ─── Disconnect ───────────────────────────────────────────────────────────

  async disconnect(): Promise<{ connected: false; disconnected: true }> {
    const token = this.tokenStorage.getQboToken();
    if (token?.access_token || token?.refresh_token) {
      try {
        const oauthClient = this.getOAuthClient(token);
        if (typeof oauthClient.revoke === 'function') {
          await oauthClient.revoke();
        }
      } catch (err) {
        this.logger.warn('QuickBooks token revoke failed; clearing locally anyway.', err);
      }
    }
    this.tokenStorage.clearQboToken();
    return { connected: false, disconnected: true };
  }

  // ─── Invoices ─────────────────────────────────────────────────────────────

  async getInvoices(): Promise<{ connected: boolean; invoices: NormalizedInvoice[] }> {
    const token = this.tokenStorage.getQboToken();
    const isConnected = !!(token?.access_token);

    if (!isConnected) return { connected: false, invoices: [] };
    if (!this.configured) return { connected: true, invoices: MOCK_INVOICES };

    try {
      const oauthClient = await this.getAuthenticatedClient();
      const realmId = token!.realmId;

      if (!realmId) return { connected: true, invoices: MOCK_INVOICES };

      const query = `select * from Invoice order by MetaData.LastUpdatedTime desc maxresults 1000`;
      const response = await oauthClient.makeApiCall({
        url: `${this.baseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });

      const data = (response as any).json || ((response as any).getJson?.() ?? response);
      const invoices: NormalizedInvoice[] = [];

      if (data.QueryResponse?.Invoice) {
        data.QueryResponse.Invoice.forEach((i: any) => {
          const balance = i.Balance !== undefined ? i.Balance : i.TotalAmt;
          const isPaid = balance === 0;
          const dueDate = i.DueDate;

          let status = 'Pending';
          let daysText = '';

          if (isPaid) {
            status = 'Paid';
            daysText = 'Succeed';
          } else if (dueDate) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const due = new Date(dueDate);
            due.setHours(0, 0, 0, 0);
            const diffDays = Math.ceil((due.getTime() - today.getTime()) / 86400000);
            if (diffDays < 0) { status = 'Pending'; daysText = 'Overdue'; }
            else if (diffDays === 0) { status = 'Pending'; daysText = 'Due today'; }
            else { status = 'Pending'; daysText = `${diffDays} days remaining`; }
          }

          let formattedDate = i.TxnDate || '06/06/2026';
          if (i.TxnDate) {
            const parts = i.TxnDate.split('-');
            if (parts.length === 3) formattedDate = `${parts[1]}/${parts[2]}/${parts[0]}`;
          }

          invoices.push({
            id: i.Id,
            docNumber: i.DocNumber || i.Id,
            name: i.CustomerRef?.name || 'Unknown Customer',
            detail: i.PrivateNote || 'QuickBooks Synced Invoice',
            date: formattedDate,
            amount: i.TotalAmt || 0,
            status,
            daysText,
          });
        });
      }

      return { connected: true, invoices: invoices.length > 0 ? invoices : MOCK_INVOICES };
    } catch (err: any) {
      this.logger.error('Error fetching QuickBooks invoices', err.message || err);
      return { connected: true, invoices: MOCK_INVOICES };
    }
  }

  // ─── Payouts ──────────────────────────────────────────────────────────────

  async getPayouts(): Promise<{ connected: boolean; payouts: NormalizedPayout[] }> {
    const token = this.tokenStorage.getQboToken();
    const isConnected = !!(token?.access_token);

    if (!isConnected) return { connected: false, payouts: [] };
    if (!this.configured) return { connected: true, payouts: MOCK_PAYOUTS };

    try {
      const oauthClient = await this.getAuthenticatedClient();
      const realmId = token!.realmId;

      if (!realmId) return { connected: true, payouts: MOCK_PAYOUTS };

      const payoutsQuery = `select * from BillPayment order by MetaData.LastUpdatedTime desc maxresults 1000`;
      const purchasesQuery = `select * from Purchase order by MetaData.LastUpdatedTime desc maxresults 1000`;

      const [payoutsRes, purchasesRes] = await Promise.all([
        oauthClient.makeApiCall({
          url: `${this.baseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(payoutsQuery)}`,
          method: 'GET',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        }).catch((e: any) => { this.logger.warn('BillPayment query failed', e.message); return null; }),
        oauthClient.makeApiCall({
          url: `${this.baseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(purchasesQuery)}`,
          method: 'GET',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        }).catch((e: any) => { this.logger.warn('Purchase query failed', e.message); return null; }),
      ]);

      const payoutsData = payoutsRes ? ((payoutsRes as any).json || (payoutsRes as any).getJson?.() || payoutsRes) : null;
      const purchasesData = purchasesRes ? ((purchasesRes as any).json || (purchasesRes as any).getJson?.() || purchasesRes) : null;

      const list: (NormalizedPayout & { rawDate: string; rawAmount: number })[] = [];

      const nameToFallback = (name: string) =>
        name.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase();

      const formatDate = (txnDate: string) => {
        const parts = txnDate.split('-');
        return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : txnDate;
      };

      if (payoutsData?.QueryResponse?.BillPayment) {
        for (const p of payoutsData.QueryResponse.BillPayment) {
          const name = p.VendorRef?.name || 'Unknown Talent';
          list.push({
            id: p.Id, name, detail: p.PrivateNote || 'QuickBooks Synced Payout',
            date: p.TxnDate ? formatDate(p.TxnDate) : '06/06/2026',
            rawDate: p.TxnDate || '1970-01-01',
            amount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(p.TotalAmt || 0),
            rawAmount: p.TotalAmt || 0,
            fallback: nameToFallback(name),
            method: p.PayType === 'BankAccount' ? 'Bank Transfer' : (p.PayType || 'Bank Transfer'),
            status: 'Paid',
          });
        }
      }

      if (purchasesData?.QueryResponse?.Purchase) {
        for (const p of purchasesData.QueryResponse.Purchase) {
          const name = p.EntityRef?.name || 'Unknown Vendor';
          list.push({
            id: p.Id, name, detail: p.PrivateNote || `Expense (${p.PaymentType || 'Cash'})`,
            date: p.TxnDate ? formatDate(p.TxnDate) : '06/06/2026',
            rawDate: p.TxnDate || '1970-01-01',
            amount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(p.TotalAmt || 0),
            rawAmount: p.TotalAmt || 0,
            fallback: nameToFallback(name),
            method: p.PaymentType === 'CreditCard' ? 'Credit Card' : (p.PaymentType || 'Cash'),
            status: 'Paid',
          });
        }
      }

      list.sort((a, b) => b.rawDate.localeCompare(a.rawDate));
      const final = list.slice(0, 10).map(({ rawDate: _r, rawAmount: _a, ...rest }) => rest);

      return { connected: true, payouts: final.length > 0 ? final : MOCK_PAYOUTS };
    } catch (err: any) {
      this.logger.error('Error fetching QuickBooks payouts', err.message || err);
      return { connected: true, payouts: MOCK_PAYOUTS };
    }
  }

  // ─── Vendors ──────────────────────────────────────────────────────────────

  async getVendors(): Promise<{ connected: boolean; vendors: any[] }> {
    const token = this.tokenStorage.getQboToken();
    if (!token?.access_token) return { connected: false, vendors: [] };
    if (!this.configured) return { connected: true, vendors: [{ id: 'v1', name: 'Karlos Talent', email: 'karlos@talent.com' }] };

    try {
      const oauthClient = await this.getAuthenticatedClient();
      const realmId = token.realmId;
      if (!realmId) return { connected: true, vendors: [] };

      const query = `select * from Vendor maxresults 20`;
      const response = await oauthClient.makeApiCall({
        url: `${this.baseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });
      const data = (response as any).json || ((response as any).getJson?.() ?? response);
      const vendors = (data.QueryResponse?.Vendor || []).map((v: any) => ({
        id: v.Id, name: v.DisplayName, email: v.PrimaryEmailAddr?.Address || '',
      }));
      return { connected: true, vendors };
    } catch (err: any) {
      this.logger.error('Error fetching vendors', err.message);
      return { connected: true, vendors: [] };
    }
  }

  // ─── Company Info ─────────────────────────────────────────────────────────

  async getCompanyInfo(): Promise<{ connected: boolean; company: any }> {
    const token = this.tokenStorage.getQboToken();
    if (!token?.access_token) return { connected: false, company: null };
    if (!this.configured) return { connected: true, company: { name: 'AgncyPay Demo Company', email: 'demo@agncypay.com' } };

    try {
      const oauthClient = await this.getAuthenticatedClient();
      const realmId = token.realmId;
      if (!realmId) return { connected: true, company: null };

      const response = await oauthClient.makeApiCall({
        url: `${this.baseUrl}/v3/company/${realmId}/companyinfo/${realmId}`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });
      const data = (response as any).json || ((response as any).getJson?.() ?? response);
      return { connected: true, company: data.CompanyInfo || null };
    } catch (err: any) {
      this.logger.error('Error fetching company info', err.message);
      return { connected: true, company: null };
    }
  }

  // ─── Webhook ──────────────────────────────────────────────────────────────

  async handleWebhook(
    payload: QuickBooksWebhookEvent,
    signature?: string,
  ): Promise<{ processed: number; skipped: number }> {
    let processed = 0;
    let skipped = 0;

    for (const notification of payload.eventNotifications || []) {
      const realmId = notification.realmId;
      for (const entity of notification.dataChangeEvent?.entities || []) {
        const dedupeKey = `${realmId}:${entity.name}:${entity.id}:${entity.lastUpdated}`;
        if (this.processedWebhooks.has(dedupeKey)) { skipped++; continue; }

        if (entity.name === 'Invoice') {
          this.eventEmitter.emit(AgncyPayEvent.QUICKBOOKS_INVOICE_RECEIVED, {
            eventId: uuidv4(), timestamp: new Date().toISOString(), source: 'QuickBooksService',
            realmId, invoiceId: entity.id, operation: entity.operation,
          });
          processed++;
        }

        this.processedWebhooks.add(dedupeKey);
        if (this.processedWebhooks.size > 10000) {
          const iter = this.processedWebhooks.values();
          this.processedWebhooks.delete(iter.next().value!);
        }
      }
    }

    return { processed, skipped };
  }
}
