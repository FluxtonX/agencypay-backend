import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
  Redirect,
  Req,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';
import { QuickBooksService } from './quickbooks.service.js';
import { Public } from '../../common/decorators/public.decorator.js';

@Public()
@Controller('quickbooks')
export class QuickBooksController {
  constructor(private readonly quickBooksService: QuickBooksService) {}

  /** Redirect browser to QuickBooks OAuth page */
  @Get('connect')
  @Redirect()
  connect() {
    if (!this.quickBooksService.configured) {
      throw new InternalServerErrorException(
        'QuickBooks OAuth is not configured. Set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET.',
      );
    }
    const url = this.quickBooksService.getConnectUrl();
    return { url, statusCode: 302 };
  }

  /**
   * OAuth callback — called by the frontend after Intuit redirects back.
   * Frontend forwards the full callback URL so backend can exchange the code.
   */
  @Post('oauth/exchange')
  @HttpCode(HttpStatus.OK)
  async oauthExchange(
    @Body() body: { callbackUrl: string; realmId?: string },
  ) {
    if (!body?.callbackUrl) throw new BadRequestException('Missing callbackUrl');
    await this.quickBooksService.exchangeOAuthCode(body.callbackUrl, body.realmId);
    return { success: true };
  }

  @Get('status')
  getStatus() {
    return this.quickBooksService.getStatus();
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnect() {
    return this.quickBooksService.disconnect();
  }

  @Delete('disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnectDelete() {
    return this.quickBooksService.disconnect();
  }

  @Get('invoices')
  async getInvoices() {
    return this.quickBooksService.getInvoices();
  }

  @Get('payouts')
  async getPayouts() {
    return this.quickBooksService.getPayouts();
  }

  @Get('vendors')
  async getVendors() {
    return this.quickBooksService.getVendors();
  }

  @Get('company')
  async getCompanyInfo() {
    return this.quickBooksService.getCompanyInfo();
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() payload: any, @Req() req: Request) {
    const signature = req.headers['intuit-signature'] as string | undefined;
    return this.quickBooksService.handleWebhook(payload, signature);
  }
}
