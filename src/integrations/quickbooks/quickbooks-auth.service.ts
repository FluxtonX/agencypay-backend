import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service.js';

@Injectable()
export class QuickBooksAuthService {
  private readonly logger = new Logger(QuickBooksAuthService.name);

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly environment: string;
  private readonly authUrl: string;
  private readonly tokenUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.clientId = this.configService.get<string>('QUICKBOOKS_CLIENT_ID');
    this.clientSecret = this.configService.get<string>('QUICKBOOKS_CLIENT_SECRET');
    this.redirectUri = this.configService.get<string>('QUICKBOOKS_REDIRECT_URI');
    this.environment = this.configService.get<string>('QUICKBOOKS_ENVIRONMENT', 'sandbox');

    this.authUrl = this.environment === 'production'
      ? 'https://appcenter.intuit.com/connect/oauth2'
      : 'https://appcenter.intuit.com/connect/oauth2'; // Same for both actually

    this.tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  }

  /**
   * Generates the authorization URL to redirect the user to QuickBooks.
   */
  getAuthorizationUrl(walletId: string, state: string) {
    const scopes = 'com.intuit.quickbooks.accounting';
    const url = new URL(this.authUrl);
    url.searchParams.append('client_id', this.clientId);
    url.searchParams.append('response_type', 'code');
    url.searchParams.append('scope', scopes);
    url.searchParams.append('redirect_uri', this.redirectUri);
    url.searchParams.append('state', state); // Should encode walletId or use a nonce

    return url.toString();
  }

  /**
   * Exchanges an authorization code for access and refresh tokens.
   */
  async exchangeCodeForToken(code: string, realmId: string, walletId: string) {
    this.logger.log(`Exchanging code for tokens (Wallet: ${walletId}, Realm: ${realmId})`);

    const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', this.redirectUri);

    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${authHeader}`,
        'Accept': 'application/json',
      },
      body: params.toString(),
    });

    const data = await response.json();

    if (!response.ok) {
      this.logger.error(`QuickBooks token exchange failed: ${JSON.stringify(data)}`);
      throw new BadRequestException('Failed to exchange QuickBooks authorization code');
    }

    // Save tokens to database
    const now = new Date();
    const expiresAt = new Date(now.getTime() + data.expires_in * 1000);
    const refreshExpiresAt = new Date(now.getTime() + data.x_refresh_token_expires_in * 1000);

    return this.prisma.quickBooksConnection.upsert({
      where: { walletId },
      create: {
        walletId,
        realmId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        refreshExpiresAt,
        status: 'ACTIVE',
      },
      update: {
        realmId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        refreshExpiresAt,
        status: 'ACTIVE',
      },
    });
  }

  /**
   * Refreshes the access token using the refresh token.
   */
  async refreshAccessToken(walletId: string) {
    const connection = await this.prisma.quickBooksConnection.findUnique({
      where: { walletId },
    });

    if (!connection) throw new Error('No QuickBooks connection found for this wallet');

    this.logger.log(`Refreshing access token for wallet: ${walletId}`);

    const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', connection.refreshToken);

    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${authHeader}`,
        'Accept': 'application/json',
      },
      body: params.toString(),
    });

    const data = await response.json();

    if (!response.ok) {
      this.logger.error(`QuickBooks token refresh failed: ${JSON.stringify(data)}`);
      // Update status to EXPIRED if refresh token is invalid
      await this.prisma.quickBooksConnection.update({
        where: { walletId },
        data: { status: 'EXPIRED' },
      });
      throw new Error('QuickBooks refresh token is invalid or expired');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + data.expires_in * 1000);
    const refreshExpiresAt = new Date(now.getTime() + data.x_refresh_token_expires_in * 1000);

    return this.prisma.quickBooksConnection.update({
      where: { walletId },
      data: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        refreshExpiresAt,
      },
    });
  }

  /**
   * Ensures a valid access token is available. Refreshes if necessary.
   */
  async getValidToken(walletId: string): Promise<string> {
    const connection = await this.prisma.quickBooksConnection.findUnique({
      where: { walletId },
    });

    if (!connection) throw new Error('No QuickBooks connection found');

    const now = new Date();
    const margin = 5 * 60 * 1000; // 5 minutes buffer

    if (connection.expiresAt.getTime() - now.getTime() > margin) {
      return connection.accessToken;
    }

    const updated = await this.refreshAccessToken(walletId);
    return updated.accessToken;
  }
}
