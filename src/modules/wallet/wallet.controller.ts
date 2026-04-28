import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { WalletService } from './wallet.service.js';
import type { CreateWalletDto, MapExternalAccountDto } from './dto/wallet.dto.js';

@Controller('wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(@Body() dto: CreateWalletDto) {
    const wallet = await this.walletService.createWallet(dto);
    return { success: true, data: wallet };
  }

  @Post('map-external')
  @HttpCode(HttpStatus.CREATED)
  async mapExternalAccount(@Body() dto: MapExternalAccountDto) {
    const mapping = await this.walletService.mapExternalAccount(dto);
    return { success: true, data: mapping };
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string) {
    const wallet = await this.walletService.getWallet(walletId);
    return { success: true, data: wallet };
  }

  @Get(':walletId/balances')
  async getWalletWithBalances(@Param('walletId') walletId: string) {
    const data = await this.walletService.getWalletWithBalances(walletId);
    return { success: true, data };
  }

  @Get()
  async listWallets(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const wallets = await this.walletService.listWallets(
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
    );
    return { success: true, data: wallets };
  }

  @Get('resolve/:provider/:externalId')
  async resolveWallet(
    @Param('provider') provider: string,
    @Param('externalId') externalId: string,
  ) {
    const wallet = await this.walletService.resolveWalletByExternalId(
      provider,
      externalId,
    );
    return { success: true, data: wallet };
  }
}
