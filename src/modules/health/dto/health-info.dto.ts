import { IsNumber, IsObject, IsString } from 'class-validator';

export class HealthInfoDto {
  @IsString()
  status: string;

  @IsString()
  service: string;

  @IsString()
  version: string;

  @IsNumber()
  uptime: number;

  @IsObject()
  memory: NodeJS.MemoryUsage;

  @IsString()
  timestamp: string;
}
