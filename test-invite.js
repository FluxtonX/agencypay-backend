import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module.js';
import { ConnectionsService } from './src/modules/connections/connections.service.js';
import { PrismaService } from './src/database/prisma.service.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const service = app.get(ConnectionsService);
  const prisma = app.get(PrismaService);

  try {
    // 1. Get a valid user to act as sender
    const user = await prisma.user.findFirst({
      where: { role: 'brand' }
    });

    if (!user) {
      console.log('No brand user found in database to test. Please register a brand user first.');
      await app.close();
      return;
    }

    console.log(`Testing sendConnectionRequest with Sender ID: ${user.id} (${user.email})`);
    
    const result = await service.sendConnectionRequest(
      user.id,
      'test-unregistered-random-email-123@email.com',
      'BRAND_TO_AGENCY'
    );
    console.log('Test invitation result:', result);
  } catch (e) {
    console.error('Test invitation caught error:', e);
  }
  await app.close();
}
bootstrap();
