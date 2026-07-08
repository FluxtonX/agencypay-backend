import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  HealthCheckResult,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { PrismaService } from '../../database/prisma.service.js';
import { HealthInfoDto } from './dto/health-info.dto.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  async checkReadiness(): Promise<HealthCheckResult> {
    try {
      return await this.health.check([
        () => this.prismaHealth.pingCheck('database', this.prisma),
      ]);
    } catch (error) {
      this.logger.error(
        'Health readiness check failed',
        error instanceof Error ? error.stack : String(error),
      );

      throw new ServiceUnavailableException({
        errorCode: 'HEALTH_CHECK_FAILED',
        message: 'Service readiness check failed',
      });
    }
  }

  getInfo(): HealthInfoDto {
    return {
      status: 'ok',
      service: 'agencypay-backend',
      version: process.env.npm_package_version ?? '0.0.1',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    };
  }
}
