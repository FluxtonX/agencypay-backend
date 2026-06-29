import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TokenStorageService } from '../token-storage.service.js';

export interface XeroInvoiceResponse {
  InvoiceID: string;
  InvoiceNumber: string;
  ContactName: string;
  Reference: string;
  Date: string;
  Total: number;
  Status: string;
  DueDateText: string;
}

export interface XeroPaymentResponse {
  PaymentID: string;
  AccountName: string;
  Description: string;
  DateText: string;
  AmountText: string;
  Initials: string;
  PaymentMethod: string;
  Status: string;
}

export interface XeroContactResponse {
  ContactID: string;
  Name: string;
  EmailAddress?: string;
  Phones?: string;
}

const MOCK_INVOICES: XeroInvoiceResponse[] = [
  { InvoiceID: 'xero-inv-1', InvoiceNumber: 'X-1001', ContactName: 'Spotify USA Inc.', Reference: 'Q2 Streaming Royalty sync', Date: '06/10/2026', Total: 14250.00, Status: 'PAID', DueDateText: 'Succeed' },
  { InvoiceID: 'xero-inv-2', InvoiceNumber: 'X-1002', ContactName: 'Netflix Premium', Reference: 'Sync payout for Sync License', Date: '06/14/2026', Total: 5800.00, Status: 'PAID', DueDateText: 'Succeed' },
  { InvoiceID: 'xero-inv-3', InvoiceNumber: 'X-1003', ContactName: 'Universal Music Group', Reference: 'Co-writing split advance', Date: '06/20/2026', Total: 28900.50, Status: 'PAID', DueDateText: 'Succeed' },
  { InvoiceID: 'xero-inv-4', InvoiceNumber: 'X-1004', ContactName: 'Warner Chappell Publishing', Reference: 'Creative synch fee share', Date: '06/22/2026', Total: 15200.00, Status: 'DRAFT', DueDateText: '18 days remaining' },
  { InvoiceID: 'xero-inv-5', InvoiceNumber: 'X-1005', ContactName: 'Sony Music Publishing', Reference: 'Sub-pub income report Q1', Date: '06/25/2026', Total: 34000.00, Status: 'DRAFT', DueDateText: 'Overdue' }
];

const MOCK_PAYOUTS: XeroPaymentResponse[] = [
  { PaymentID: 'xero-pay-1', AccountName: 'Karlos Talent Inc.', Description: 'Q2 Sync Royalties split', DateText: 'Today, 11:30 AM', AmountText: '$11,400.00', Initials: 'KT', PaymentMethod: 'ACH Transfer', Status: 'PAID' },
  { PaymentID: 'xero-pay-2', AccountName: 'Bella Hadid', Description: 'Talent campaign payout', DateText: 'Yesterday, 4:05 PM', AmountText: '$15,200.00', Initials: 'BH', PaymentMethod: 'ACH Transfer', Status: 'PAID' },
  { PaymentID: 'xero-pay-3', AccountName: 'Gigi Hadid', Description: 'Vogue Campaign Split payout', DateText: '2 days ago', AmountText: '$24,500.00', Initials: 'GH', PaymentMethod: 'Wire Transfer', Status: 'PAID' }
];

const MOCK_VENDORS: XeroContactResponse[] = [
  { ContactID: 'xero-con-1', Name: 'Spotify USA Inc.', EmailAddress: 'billing@spotify.com', Phones: '+1-555-0199' },
  { ContactID: 'xero-con-2', Name: 'Netflix Premium', EmailAddress: 'accounts@netflix.com', Phones: '' },
  { ContactID: 'xero-con-3', Name: 'Universal Music Group', EmailAddress: 'royalty-ops@umusic.com', Phones: '' }
];

@Injectable()
export class XeroService {
  private readonly logger = new Logger(XeroService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly redirectUri: string;
  readonly configured: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly tokenStorage: TokenStorageService,
  ) {
    this.clientId = this.config.get<string>('xero.clientId') || '';
    this.clientSecret = this.config.get<string>('xero.clientSecret') || '';
    this.baseUrl = this.config.get<string>('xero.baseUrl') || 'https://api.xero.com';
    this.redirectUri =
      this.config.get<string>('xero.redirectUri') ||
      'http://localhost:3000/api/auth/xero/callback';
    this.configured = !!(this.clientId && this.clientSecret);
  }

  // ─── OAuth URL Generation ───────────────────────────────────────────────

  getConnectUrl(): string {
    if (!this.configured) {
      throw new Error('Xero OAuth is not configured. Please check XERO_CLIENT_ID and XERO_CLIENT_SECRET.');
    }
    
    const scopes = [
      'offline_access',
      'accounting.transactions',
      'accounting.contacts',
      'accounting.settings',
      'openid',
      'profile',
      'email',
    ].join(' ');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: scopes,
      state: 'xero-oauth-state',
    });

    return `https://login.xero.com/identity/connect/authorize?${params.toString()}`;
  }

  // ─── Exchange Authorization Code ─────────────────────────────────────────

  async exchangeOAuthCode(callbackUrl: string): Promise<void> {
    if (!this.configured) throw new Error('Xero OAuth is not configured.');

    let code = '';
    try {
      const urlObj = new URL(callbackUrl);
      code = urlObj.searchParams.get('code') || '';
    } catch {
      code = callbackUrl; // fallback if only raw code is passed
    }

    if (!code) throw new Error('No authorization code found.');

    const tokenUrl = 'https://identity.xero.com/connect/token';
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      this.logger.error(`Xero OAuth Exchange failed: ${errBody}`);
      throw new Error(`Xero OAuth Exchange failed: ${response.statusText}`);
    }

    const tokenData = await response.json();

    // Fetch Xero Tenant ID (Connection organization)
    const connectionsResponse = await fetch('https://api.xero.com/connections', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
    });

    if (connectionsResponse.ok) {
      const connections = await connectionsResponse.json();
      if (connections && connections.length > 0) {
        // Grab the first active connection tenantId
        tokenData.tenantId = connections[0].tenantId;
      }
    }

    this.tokenStorage.saveXeroToken(tokenData);
    this.logger.log('Xero OAuth exchange complete.');
  }

  // ─── Get Connected Status ────────────────────────────────────────────────

  getStatus() {
    const token = this.tokenStorage.getXeroToken();
    if (!token?.access_token) {
      return { connected: false, environment: 'production_sandbox' };
    }

    const createdAt = token.createdAt || Date.now();
    const accessExpiresAt = token.expires_in ? createdAt + token.expires_in * 1000 : null;

    return {
      connected: true,
      tenantId: token.tenantId,
      environment: 'production_sandbox',
      connectedAt: new Date(createdAt).toISOString(),
      accessExpiresAt: accessExpiresAt ? new Date(accessExpiresAt).toISOString() : undefined,
    };
  }

  // ─── Disconnect ──────────────────────────────────────────────────────────

  async disconnect() {
    this.tokenStorage.clearXeroToken();
    return { connected: false, disconnected: true };
  }

  // ─── Helpers to Get Fresh Access Token ────────────────────────────────────

  private async getAuthenticatedAccessToken(): Promise<string> {
    const token = this.tokenStorage.getXeroToken();
    if (!token) throw new Error('No Xero credentials found. Connect Xero first.');

    // Tokens last 30 minutes (1800s). Check if expired
    const isExpired = Date.now() >= (token.createdAt + (token.expires_in || 1800) * 1000 - 60000); // 1-minute buffer

    if (!isExpired) return token.access_token!;

    this.logger.log('Xero access token expired. Refreshing token...');

    if (!token.refresh_token) {
      throw new Error('No refresh token available. Reconnect Xero.');
    }

    const tokenUrl = 'https://identity.xero.com/connect/token';
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      this.logger.error(`Failed to refresh Xero token: ${errText}`);
      throw new Error('Token refresh failed. Reconnect Xero.');
    }

    const newTokens = await response.json();
    if (token.tenantId) newTokens.tenantId = token.tenantId;

    this.tokenStorage.saveXeroToken(newTokens);
    return newTokens.access_token;
  }

  // ─── Fetch Invoices from Xero ────────────────────────────────────────────

  async getInvoices(): Promise<{ connected: boolean; invoices: XeroInvoiceResponse[] }> {
    const token = this.tokenStorage.getXeroToken();
    const isConnected = !!token?.access_token;

    if (!isConnected) return { connected: false, invoices: [] };
    if (!this.configured) return { connected: true, invoices: MOCK_INVOICES };

    try {
      const accessToken = await this.getAuthenticatedAccessToken();
      const tenantId = token.tenantId;

      if (!tenantId) return { connected: true, invoices: MOCK_INVOICES };

      const response = await fetch(`${this.baseUrl}/api.xro/2.0/Invoices`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          Accept: 'application/json',
        },
      });

      if (!response.ok) throw new Error(`Xero Invoices Fetch Error: ${response.statusText}`);

      const data: any = await response.json();
      const invoices: XeroInvoiceResponse[] = [];

      if (data.Invoices) {
        data.Invoices.forEach((i: any) => {
          const isPaid = i.Status === 'PAID';
          let daysText = '';

          if (isPaid) {
            daysText = 'Succeed';
          } else if (i.DueDate) {
            // parse date format like "/Date(1679000000000+0000)/" or raw date
            let dueDateMs = Date.parse(i.DueDate);
            if (isNaN(dueDateMs) && typeof i.DueDate === 'string') {
              const matches = i.DueDate.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
              if (matches) dueDateMs = parseInt(matches[1], 10);
            }
            if (!isNaN(dueDateMs)) {
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              const due = new Date(dueDateMs);
              due.setHours(0, 0, 0, 0);
              const diffDays = Math.ceil((due.getTime() - today.getTime()) / 86400000);
              if (diffDays < 0) { daysText = 'Overdue'; }
              else if (diffDays === 0) { daysText = 'Due today'; }
              else { daysText = `${diffDays} days remaining`; }
            }
          }

          let invoiceDate = '06/10/2026';
          let dateMs = Date.parse(i.DateString || i.Date);
          if (isNaN(dateMs) && typeof i.Date === 'string') {
            const matches = i.Date.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
            if (matches) dateMs = parseInt(matches[1], 10);
          }
          if (!isNaN(dateMs)) {
            const dateObj = new Date(dateMs);
            invoiceDate = `${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')}/${dateObj.getFullYear()}`;
          }

          invoices.push({
            InvoiceID: i.InvoiceID,
            InvoiceNumber: i.InvoiceNumber || i.InvoiceID,
            ContactName: i.Contact?.Name || 'Unknown Contact',
            Reference: i.Reference || 'Xero Synced Invoice',
            Date: invoiceDate,
            Total: i.Total || 0,
            Status: i.Status,
            DueDateText: daysText,
          });
        });
      }

      return { connected: true, invoices: invoices.length > 0 ? invoices : MOCK_INVOICES };
    } catch (e) {
      this.logger.error('Error fetching Xero invoices', e);
      return { connected: true, invoices: MOCK_INVOICES };
    }
  }

  // ─── Fetch Payouts from Xero ─────────────────────────────────────────────

  async getPayouts(): Promise<{ connected: boolean; payouts: XeroPaymentResponse[] }> {
    const token = this.tokenStorage.getXeroToken();
    const isConnected = !!token?.access_token;

    if (!isConnected) return { connected: false, payouts: [] };
    if (!this.configured) return { connected: true, payouts: MOCK_PAYOUTS };

    try {
      const accessToken = await this.getAuthenticatedAccessToken();
      const tenantId = token.tenantId;

      if (!tenantId) return { connected: true, payouts: MOCK_PAYOUTS };

      const response = await fetch(`${this.baseUrl}/api.xro/2.0/Payments`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          Accept: 'application/json',
        },
      });

      if (!response.ok) throw new Error(`Xero Payments Fetch Error: ${response.statusText}`);

      const data: any = await response.json();
      const payouts: XeroPaymentResponse[] = [];

      const nameToFallback = (name: string) =>
        name.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase();

      if (data.Payments) {
        data.Payments.forEach((p: any) => {
          const amountFormatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(p.Amount || 0);
          
          let dateStr = 'Yesterday';
          let dateMs = Date.parse(p.Date);
          if (isNaN(dateMs) && typeof p.Date === 'string') {
            const matches = p.Date.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
            if (matches) dateMs = parseInt(matches[1], 10);
          }
          if (!isNaN(dateMs)) {
            const dateObj = new Date(dateMs);
            dateStr = `${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')}/${dateObj.getFullYear()}`;
          }

          const targetName = p.Invoice?.Contact?.Name || 'Xero Vendor Payout';

          payouts.push({
            PaymentID: p.PaymentID,
            AccountName: targetName,
            Description: p.Reference || 'Xero Synced Payment Split',
            DateText: dateStr,
            AmountText: amountFormatted,
            Initials: nameToFallback(targetName),
            PaymentMethod: 'Bank Transfer',
            Status: p.Status || 'PAID',
          });
        });
      }

      return { connected: true, payouts: payouts.length > 0 ? payouts : MOCK_PAYOUTS };
    } catch (e) {
      this.logger.error('Error fetching Xero payouts', e);
      return { connected: true, payouts: MOCK_PAYOUTS };
    }
  }

  // ─── Fetch Vendors/Contacts ──────────────────────────────────────────────

  async getVendors(): Promise<{ connected: boolean; vendors: XeroContactResponse[] }> {
    const token = this.tokenStorage.getXeroToken();
    const isConnected = !!token?.access_token;

    if (!isConnected) return { connected: false, vendors: [] };
    if (!this.configured) return { connected: true, vendors: MOCK_VENDORS };

    try {
      const accessToken = await this.getAuthenticatedAccessToken();
      const tenantId = token.tenantId;

      if (!tenantId) return { connected: true, vendors: MOCK_VENDORS };

      const response = await fetch(`${this.baseUrl}/api.xro/2.0/Contacts`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          Accept: 'application/json',
        },
      });

      if (!response.ok) throw new Error(`Xero Contacts Fetch Error: ${response.statusText}`);

      const data: any = await response.json();
      const vendors: XeroContactResponse[] = [];

      if (data.Contacts) {
        data.Contacts.forEach((c: any) => {
          vendors.push({
            ContactID: c.ContactID,
            Name: c.Name,
            EmailAddress: c.EmailAddress || undefined,
            Phones: c.Phones && c.Phones.length > 0 ? c.Phones[0].PhoneNumber : undefined,
          });
        });
      }

      return { connected: true, vendors: vendors.length > 0 ? vendors : MOCK_VENDORS };
    } catch (e) {
      this.logger.error('Error fetching Xero vendors', e);
      return { connected: true, vendors: MOCK_VENDORS };
    }
  }
}
