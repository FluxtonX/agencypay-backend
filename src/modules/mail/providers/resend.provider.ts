import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ResendProvider {
  private readonly logger = new Logger(ResendProvider.name);
  private readonly apiKey: string | null = null;
  private readonly baseUrl = 'https://api.resend.com';

  constructor(private readonly configService: ConfigService) {
    const rawKey = this.configService.get<string>('RESEND_API_KEY');
    this.apiKey = rawKey ? rawKey.replace(/^["']|["']$/g, '').trim() : null;
  }

  async sendEmail(to: string, subject: string, text: string): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn(`RESEND_API_KEY is not configured. Email to ${to} will fallback to console log.`);
      this.logFallback(to, subject, text);
      return;
    }

    try {
      const response = await fetch(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'AgencyPay <onboarding@resend.dev>',
          to: [to],
          subject,
          text,
        }),
      });

      const body: any = await response.json();
      if (!response.ok) {
        throw new Error(body?.message || `HTTP error ${response.status}`);
      }

      this.logger.log(`Email successfully sent via Resend to ${to}. ID: ${body.id}`);
    } catch (err: any) {
      this.logger.error(`Failed to send email to ${to} via Resend: ${err.message}`);
      throw err;
    }
  }

  private logFallback(to: string, subject: string, text: string) {
    this.logger.log(
      `\n\n======================================================\n` +
      `[RESEND EMAIL INBOX FALLBACK] -> ${to}\n` +
      `Subject: ${subject}\n` +
      `------------------------------------------------------\n` +
      `${text}\n` +
      `======================================================\n\n`,
    );
  }
}
