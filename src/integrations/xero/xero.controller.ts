import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
  Redirect,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { XeroService } from './xero.service.js';
import { Public } from '../../common/decorators/public.decorator.js';

@Public()
@Controller('xero')
export class XeroController {
  constructor(private readonly xeroService: XeroService) {}

  /** Redirect browser to Xero OAuth consent page */
  @Get('connect')
  @Redirect()
  connect() {
    if (!this.xeroService.configured) {
      throw new InternalServerErrorException(
        'Xero OAuth is not configured. Please set XERO_CLIENT_ID and XERO_CLIENT_SECRET.',
      );
    }
    const url = this.xeroService.getConnectUrl();
    return { url, statusCode: 302 };
  }

  /** Exchange code for token (called by frontend callback redirect page) */
  @Post('oauth/exchange')
  @HttpCode(HttpStatus.OK)
  async oauthExchange(@Body() body: { callbackUrl: string }) {
    if (!body?.callbackUrl) throw new BadRequestException('Missing callbackUrl');
    await this.xeroService.exchangeOAuthCode(body.callbackUrl);
    return { success: true };
  }

  @Get('status')
  getStatus() {
    return this.xeroService.getStatus();
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnect() {
    return this.xeroService.disconnect();
  }

  @Delete('disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnectDelete() {
    return this.xeroService.disconnect();
  }

  @Get('invoices')
  async getInvoices() {
    return this.xeroService.getInvoices();
  }

  @Get('payouts')
  async getPayouts() {
    return this.xeroService.getPayouts();
  }

  @Get('vendors')
  async getVendors() {
    return this.xeroService.getVendors();
  }
}
