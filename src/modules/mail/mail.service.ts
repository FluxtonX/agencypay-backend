import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private fromAddress = 'AgncyPay <noreply@agncypay.com>';

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT');
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');
    const from = this.configService.get<string>('SMTP_FROM');

    if (from) {
      this.fromAddress = from;
    }

    if (host && port && user && pass) {
      this.logger.log(`SMTP configured: host=${host}, port=${port}, user=${user}. Initializing transporter...`);
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: Number(port) === 465,
        auth: {
          user,
          pass,
        },
      });
    } else {
      this.logger.warn(
        'SMTP environment variables are not fully configured. Reset password emails will log to the terminal console.',
      );
    }
  }

  async sendPasswordResetMail(to: string, resetLink: string) {
    const subject = 'Reset Your Password - AgncyPay';
    const htmlContent = `
      <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0f172a; margin-bottom: 16px;">Password Reset Request</h2>
        <p style="color: #475569; font-size: 14px; line-height: 1.5;">
          A request has been made to reset the password for your AgncyPay account. Click the button below to restore access:
        </p>
        <div style="margin: 24px 0; text-align: center;">
          <a href="${resetLink}" style="background-color: #0f172a; color: #ffffff; padding: 12px 24px; font-weight: bold; font-size: 14px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Reset Password
          </a>
        </div>
        <p style="color: #64748b; font-size: 12px; line-height: 1.5;">
          If the button does not work, copy and paste this URL into your browser:
        </p>
        <p style="word-break: break-all; font-size: 12px; color: #3b82f6;">
          <a href="${resetLink}">${resetLink}</a>
        </p>
        <p style="color: #64748b; font-size: 11px; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 16px;">
          This link will expire in 15 minutes. If you did not request a password reset, please ignore this email.
        </p>
      </div>
    `;

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: this.fromAddress,
          to,
          subject,
          html: htmlContent,
        });
        this.logger.log(`Password reset email successfully sent to ${to}`);
      } catch (err: any) {
        this.logger.error(`Failed to send password reset email to ${to}`, err.stack || err);
        this.logFallback(to, resetLink);
      }
    } else {
      this.logFallback(to, resetLink);
    }
  }

  private logFallback(to: string, resetLink: string) {
    this.logger.log(
      `\n\n======================================================\n` +
      `[PASSWORD RESET EMAIL INBOX FALLBACK] -> ${to}\n` +
      `------------------------------------------------------\n` +
      `To reset your password, open the following link in your browser:\n\n` +
      `${resetLink}\n` +
      `======================================================\n\n`,
    );
  }
}
