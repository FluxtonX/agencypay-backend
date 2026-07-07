import { Injectable, Logger } from '@nestjs/common';
import { ResendProvider } from './providers/resend.provider.js';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly resendProvider: ResendProvider) {}

  async sendInvitationEmail(to: string, inviteLink: string): Promise<void> {
    const subject = "You're invited to join AgencyPay";
    const body = 
      `You have been invited to AgencyPay.\n\n` +
      `Click below to accept your invitation:\n\n` +
      `${inviteLink}\n\n` +
      `This invitation will expire soon.`;

    await this.resendProvider.sendEmail(to, subject, body);
  }
}
