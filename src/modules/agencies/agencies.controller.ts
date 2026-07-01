import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AgenciesService } from './agencies.service.js';
import { InviteAgencyDto } from './dto/invite-agency.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { UserRole } from '../../common/constants/roles.js';

@Controller('agencies')
export class AgenciesController {
  constructor(private readonly agenciesService: AgenciesService) {}

  /**
   * Invites an agency by email. Restrained to BRANDS.
   */
  @Post('invite')
  @Roles(UserRole.BRAND)
  @HttpCode(HttpStatus.CREATED)
  async inviteAgency(@Req() req: any, @Body() dto: InviteAgencyDto) {
    const brandId = req.user.userId;
    const invitation = await this.agenciesService.inviteAgency(brandId, dto.email);
    return { success: true, data: invitation };
  }

  /**
   * Resends a pending or expired invitation. Restrained to BRANDS.
   */
  @Post('invitations/:id/resend')
  @Roles(UserRole.BRAND)
  @HttpCode(HttpStatus.OK)
  async resendInvitation(@Req() req: any, @Param('id') id: string) {
    const brandId = req.user.userId;
    const invitation = await this.agenciesService.resendInvitation(brandId, id);
    return { success: true, data: invitation };
  }

  /**
   * Cancels a pending invitation. Restrained to BRANDS.
   */
  @Post('invitations/:id/cancel')
  @Roles(UserRole.BRAND)
  @HttpCode(HttpStatus.OK)
  async cancelInvitation(@Req() req: any, @Param('id') id: string) {
    const brandId = req.user.userId;
    const result = await this.agenciesService.cancelInvitation(brandId, id);
    return { success: true, data: result };
  }

  /**
   * Lists invitations sent by the brand. Restrained to BRANDS.
   */
  @Get('invitations')
  @Roles(UserRole.BRAND)
  @HttpCode(HttpStatus.OK)
  async getInvitations(@Req() req: any) {
    const brandId = req.user.userId;
    const invitations = await this.agenciesService.getInvitations(brandId);
    return { success: true, data: invitations };
  }

  /**
   * Lists connected agencies for the brand. Restrained to BRANDS.
   */
  @Get('connected')
  @Roles(UserRole.BRAND)
  @HttpCode(HttpStatus.OK)
  async getConnectedAgencies(@Req() req: any) {
    const brandId = req.user.userId;
    const connections = await this.agenciesService.getConnectedAgencies(brandId);
    return { success: true, data: connections };
  }

  /**
   * Sandbox only: Simulates an agency accepting an invitation.
   * Publicly accessible for UI testing purposes.
   */
  @Public()
  @Post('invitations/:id/accept-sandbox')
  @HttpCode(HttpStatus.OK)
  async acceptInvitationSandbox(@Param('id') id: string) {
    const relationship = await this.agenciesService.acceptInvitationSandbox(id);
    return { success: true, data: relationship };
  }

  /**
   * Lists connected brands for the agency. Restrained to AGENCIES.
   */
  @Get('brands')
  @Roles(UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async getConnectedBrands(@Req() req: any) {
    const agencyId = req.user.userId;
    const connections = await this.agenciesService.getConnectedBrands(agencyId);
    return { success: true, data: connections };
  }

  /**
   * Lists incoming invitations for the agency. Restrained to AGENCIES.
   */
  @Get('incoming-invitations')
  @Roles(UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async getIncomingInvitations(@Req() req: any) {
    const email = req.user.email;
    const invitations = await this.agenciesService.getIncomingInvitations(email);
    return { success: true, data: invitations };
  }

  /**
   * Accepts a brand invitation. Restrained to AGENCIES.
   */
  @Post('invitations/:id/accept')
  @Roles(UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async acceptInvitation(@Req() req: any, @Param('id') id: string) {
    const agencyId = req.user.userId;
    const relationship = await this.agenciesService.acceptInvitation(agencyId, id);
    return { success: true, data: relationship };
  }
}
