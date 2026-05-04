import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckResult } from '@nestjs/terminus';
import { Public } from '../../common/decorators/public.decorator.js';
import { HealthInfoDto } from './dto/health-info.dto.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * GET /api/v1/health
   * Liveness + readiness probe. Checks DB connectivity.
   * Public — no auth required.
   */
  @Get()
  @Public()
  @HealthCheck()
  async check(): Promise<HealthCheckResult> {
    return this.healthService.checkReadiness();
  }

  /**
   * GET /api/v1/health/info
   * Returns system info for monitoring dashboards.
   * Public — no auth required.
   */
  @Get('info')
  @Public()
  getInfo(): HealthInfoDto {
    return this.healthService.getInfo();
  }
}
