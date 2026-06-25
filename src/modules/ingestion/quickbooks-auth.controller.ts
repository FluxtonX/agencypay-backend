import {
  Controller,
  Get,
  Query,
  Res,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { QuickBooksAuthService } from '../../integrations/quickbooks/quickbooks-auth.service.js';
import { Public } from '../../common/decorators/public.decorator.js';

@Controller('auth/quickbooks')
export class QuickBooksAuthController {
  private readonly logger = new Logger(QuickBooksAuthController.name);

  constructor(private readonly authService: QuickBooksAuthService) {}

  /**
   * GET /auth/quickbooks/connect?walletId=...
   * Redirects the user to the QuickBooks Authorization page.
   */
  @Get('connect')
  @Public() // In production, this should be protected by JWT
  connect(@Query('walletId') walletId: string, @Res() res: Response) {
    if (!walletId) {
      throw new BadRequestException('walletId is required');
    }

    const state = JSON.stringify({ walletId });
    const url = this.authService.getAuthorizationUrl(walletId, state);
    
    this.logger.log(`Redirecting to QuickBooks auth: ${url}`);
    return res.redirect(url);
  }

  /**
   * GET /auth/quickbooks/callback
   * Handles the redirect from QuickBooks after authorization.
   */
  @Get('callback')
  @Public()
  async callback(
    @Query('code') code: string,
    @Query('realmId') realmId: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Received QuickBooks callback for realm: ${realmId}`);

    try {
      const { walletId } = JSON.parse(state);
      
      await this.authService.exchangeCodeForToken(code, realmId, walletId);

      // In production, redirect to a frontend success page
      return res.send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1 style="color: #2e7d32;">Success!</h1>
            <p>Your QuickBooks account has been connected to AgencyPay.</p>
            <p>You can close this window now.</p>
          </body>
        </html>
      `);
    } catch (error) {
      this.logger.error(`QuickBooks callback error: ${error.message}`);
      return res.status(400).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1 style="color: #c62828;">Connection Failed</h1>
            <p>${error.message}</p>
            <p><a href="/auth/quickbooks/connect">Try again</a></p>
          </body>
        </html>
      `);
    }
  }
}
