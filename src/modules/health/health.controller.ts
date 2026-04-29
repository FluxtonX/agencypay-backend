import { Controller, Get } from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  HealthCheckResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../../common/decorators/public.decorator.js';
import { PrismaService } from '../../database/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
    private prisma: PrismaService,
  ) {}

  /**
   * GET /api/v1/health
   * Liveness + readiness probe. Checks DB connectivity.
   * Public — no auth required.
   */
  @Get()
  @Public()
  @HealthCheck()
  async check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
    ]);
  }

  /**
   * GET /api/v1/health/info
   * Returns system info for monitoring dashboards.
   * Public — no auth required.
   */
  @Get('info')
  @Public()
  getInfo() {
    return {
      status: 'ok',
      version:2.0,
      service: 'agncypay-backend',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    };
  }
}
