import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import { TokenStorageService } from '../token-storage.service.js';

@Injectable()
export class PlaidService {
  private readonly logger = new Logger(PlaidService.name);
  private readonly plaidClient: PlaidApi;
  private readonly isConfigured: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly tokenStorage: TokenStorageService,
  ) {
    const clientId = (config.get<string>('plaid.clientId') || '').replace(/^["']|["']$/g, '');
    const secret = (config.get<string>('plaid.secret') || '').replace(/^["']|["']$/g, '');
    const env = (config.get<string>('plaid.env') || 'sandbox').replace(/^["']|["']$/g, '');

    this.isConfigured = !!(
      clientId &&
      secret &&
      clientId !== 'your_plaid_client_id' &&
      !clientId.startsWith('your_')
    );

    const basePath = PlaidEnvironments[env] || PlaidEnvironments.sandbox;

    const plaidConfig = new Configuration({
      basePath,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': clientId,
          'PLAID-SECRET': secret,
        },
      },
    });

    this.plaidClient = new PlaidApi(plaidConfig);
  }

  get configured(): boolean {
    return this.isConfigured;
  }

  // ─── Create Link Token ────────────────────────────────────────────────────

  async createLinkToken(webhookUrl?: string): Promise<{
    link_token: string | null;
    isMock: boolean;
  }> {
    if (!this.isConfigured) {
      this.logger.warn('Plaid not configured. Returning mock link token.');
      return { link_token: null, isMock: true };
    }

    const tokenRequest: any = {
      user: { client_user_id: 'agncypay-user-session' },
      client_name: 'AgncyPay',
      products: [Products.Auth, Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    };

    if (webhookUrl) {
      tokenRequest.webhook = webhookUrl;
    }

    try {
      const response = await this.plaidClient.linkTokenCreate(tokenRequest);
      return { link_token: response.data.link_token, isMock: false };
    } catch (error: any) {
      this.logger.error('Failed to create Plaid link token', error.response?.data || error.message);
      throw new BadRequestException('Failed to create Plaid link token');
    }
  }

  // ─── Exchange Token ───────────────────────────────────────────────────────

  async exchangeToken(
    publicToken: string,
    institution?: { name?: string; institution_id?: string },
  ): Promise<{ success: boolean; item_id: string; isMock: boolean }> {
    const isMock = !this.isConfigured || publicToken.startsWith('mock-');

    if (isMock) {
      this.logger.warn('Saving mock Plaid token.');
      this.tokenStorage.savePlaidToken({
        accessToken: 'mock-access-token-12345',
        itemId: 'item_mock_sandbox_9988',
        institutionName: institution?.name || 'Plaid Sandbox Bank',
        institutionId: institution?.institution_id || 'ins_sandbox',
      });
      return { success: true, item_id: 'item_mock_sandbox_9988', isMock: true };
    }

    try {
      const response = await this.plaidClient.itemPublicTokenExchange({ public_token: publicToken });
      const accessToken = response.data.access_token;
      const itemId = response.data.item_id;

      this.tokenStorage.savePlaidToken({
        accessToken,
        itemId,
        institutionName: institution?.name || 'Sandbox Institution',
        institutionId: institution?.institution_id || 'ins_sandbox',
      });

      this.logger.log(`Plaid token exchanged. Item ID: ${itemId}`);
      return { success: true, item_id: itemId, isMock: false };
    } catch (error: any) {
      this.logger.error(
        'Token exchange failed, saving mock token.',
        error.response?.data || error.message,
      );
      this.tokenStorage.savePlaidToken({
        accessToken: 'mock-access-token-12345',
        itemId: 'item_mock_sandbox_9988',
        institutionName: institution?.name || 'Plaid Sandbox Bank',
        institutionId: institution?.institution_id || 'ins_sandbox',
      });
      return { success: true, item_id: 'item_mock_sandbox_9988', isMock: true };
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus(): {
    connected: boolean;
    institutionName?: string;
    institutionId?: string;
    itemId?: string;
    connectedAt?: string;
    environment: string;
  } {
    const env = this.config.get<string>('plaid.env') || 'sandbox';
    const data = this.tokenStorage.getPlaidToken();

    if (!data?.accessToken) {
      return { connected: false, environment: env };
    }

    return {
      connected: true,
      institutionName: data.institutionName || 'Linked Bank',
      institutionId: data.institutionId,
      itemId: data.itemId,
      connectedAt: data.connectedAt,
      environment: env,
    };
  }

  // ─── Disconnect ───────────────────────────────────────────────────────────

  async disconnect(): Promise<{ success: boolean }> {
    const data = this.tokenStorage.getPlaidToken();

    if (data?.accessToken && this.isConfigured && !data.accessToken.startsWith('mock-')) {
      try {
        await this.plaidClient.itemRemove({ access_token: data.accessToken });
        this.logger.log('Plaid access token revoked.');
      } catch (err: any) {
        this.logger.warn('Could not revoke Plaid token on API, clearing locally.', err.message);
      }
    }

    this.tokenStorage.clearPlaidToken();
    return { success: true };
  }

  // ─── Get Accounts ─────────────────────────────────────────────────────────

  async getAccounts(): Promise<any[]> {
    const data = this.tokenStorage.getPlaidToken();
    if (!data?.accessToken) throw new NotFoundException('No Plaid connection found.');

    if (!this.isConfigured || data.accessToken.startsWith('mock-')) {
      return [
        { account_id: 'mock_acc_1', name: 'Mock Checking', type: 'depository', balances: { available: 5000, current: 5000 } },
        { account_id: 'mock_acc_2', name: 'Mock Savings', type: 'depository', balances: { available: 12000, current: 12000 } },
      ];
    }

    const response = await this.plaidClient.accountsGet({ access_token: data.accessToken });
    return response.data.accounts;
  }

  // ─── Webhook ──────────────────────────────────────────────────────────────

  async handleWebhook(payload: any): Promise<{ success: boolean }> {
    const { webhook_type, webhook_code } = payload;
    this.logger.log(`Plaid webhook received: ${webhook_type}/${webhook_code}`);

    const data = this.tokenStorage.getPlaidToken();
    if (!data?.accessToken) return { success: true };

    if (webhook_type === 'TRANSACTIONS' && ['SYNC_UPDATES_AVAILABLE', 'INITIAL_UPDATE', 'DEFAULT_UPDATE'].includes(webhook_code)) {
      try {
        const syncResponse = await this.plaidClient.transactionsSync({
          access_token: data.accessToken,
          count: 100,
        });
        const { added, modified, removed } = syncResponse.data;
        this.logger.log(`Plaid sync: +${added.length} ~${modified.length} -${removed.length}`);
      } catch (err: any) {
        this.logger.warn('Plaid transaction sync failed:', err.message);
      }
    }

    return { success: true };
  }
}
