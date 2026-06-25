import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { PlaidService } from './plaid.service.js';
import { Public } from '../../common/decorators/public.decorator.js';

@Public()
@Controller('plaid')
export class PlaidController {
  constructor(private readonly plaidService: PlaidService) {}

  @Post('create-link-token')
  @HttpCode(HttpStatus.OK)
  async createLinkToken(@Body() body: { webhookUrl?: string }) {
    return this.plaidService.createLinkToken(body?.webhookUrl);
  }

  @Post('exchange-token')
  @HttpCode(HttpStatus.OK)
  async exchangeToken(
    @Body() body: { public_token: string; institution?: { name?: string; institution_id?: string } },
  ) {
    if (!body?.public_token) {
      throw new BadRequestException('Missing public_token');
    }
    return this.plaidService.exchangeToken(body.public_token, body.institution);
  }

  @Get('status')
  getStatus() {
    return this.plaidService.getStatus();
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnect() {
    return this.plaidService.disconnect();
  }

  @Get('accounts')
  async getAccounts() {
    return this.plaidService.getAccounts();
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() payload: any) {
    return this.plaidService.handleWebhook(payload);
  }
}
