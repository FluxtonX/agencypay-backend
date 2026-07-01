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
import { TalentsService } from './talents.service.js';
import { InviteTalentDto } from './dto/invite-talent.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { UserRole } from '../../common/constants/roles.js';

@Controller('talents')
export class TalentsController {
  constructor(private readonly talentsService: TalentsService) {}

  /**
   * Invites a talent by email. Restrained to AGENCIES.
   */
  @Post('invite')
  @Roles(UserRole.AGENCY)
  @HttpCode(HttpStatus.CREATED)
  async inviteTalent(@Req() req: any, @Body() dto: InviteTalentDto) {
    const agencyId = req.user.userId;
    const invitation = await this.talentsService.inviteTalent(agencyId, dto.email);
    return { success: true, data: invitation };
  }

  /**
   * Resends a pending or expired invitation. Restrained to AGENCIES.
   */
  @Post('invitations/:id/resend')
  @Roles(UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async resendInvitation(@Req() req: any, @Param('id') id: string) {
    const agencyId = req.user.userId;
    const invitation = await this.talentsService.resendInvitation(agencyId, id);
    return { success: true, data: invitation };
  }

  /**
   * Cancels a pending invitation. Restrained to AGENCIES.
   */
  @Post('invitations/:id/cancel')
  @Roles(UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async cancelInvitation(@Req() req: any, @Param('id') id: string) {
    const agencyId = req.user.userId;
    const result = await this.talentsService.cancelInvitation(agencyId, id);
    return { success: true, data: result };
  }

  /**
   * Lists invitations sent by the agency. Restrained to AGENCIES.
   */
  @Get('invitations')
  @Roles(UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async getInvitations(@Req() req: any) {
    const agencyId = req.user.userId;
    const invitations = await this.talentsService.getInvitations(agencyId);
    return { success: true, data: invitations };
  }

  /**
   * Lists connected talents for the agency. Restrained to AGENCIES.
   */
  @Get('connected')
  @Roles(UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async getConnectedTalents(@Req() req: any) {
    const agencyId = req.user.userId;
    const connections = await this.talentsService.getConnectedTalents(agencyId);
    return { success: true, data: connections };
  }

  /**
   * Sandbox only: Simulates a talent accepting an invitation.
   * Publicly accessible for UI testing purposes.
   */
  @Public()
  @Post('invitations/:id/accept-sandbox')
  @HttpCode(HttpStatus.OK)
  async acceptInvitationSandbox(@Param('id') id: string) {
    const relationship = await this.talentsService.acceptInvitationSandbox(id);
    return { success: true, data: relationship };
  }
}
