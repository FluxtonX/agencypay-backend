import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailService } from './mail.service.js';
import { ResendProvider } from './providers/resend.provider.js';
import { EmailService } from './email.service.js';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [MailService, ResendProvider, EmailService],
  exports: [MailService, EmailService],
})
export class MailModule {}
