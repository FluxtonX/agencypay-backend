import { Controller, Get, Post, Delete, Body, Param, Req, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ConnectionsService } from './connections.service.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../common/constants/roles.js';

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  /**
   * Search registered users by email or fullName.
   */
  @Get('search')
  @Roles(UserRole.BRAND, UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async search(@Req() req: any, @Query('query') query: string) {
    const currentUserId = req.user.userId;
    const currentUserRole = req.user.roles[0];
    const users = await this.connectionsService.searchUsers(query || '', currentUserId, currentUserRole);
    return { success: true, data: users };
  }

  /**
   * Retrieves synced QuickBooks / Xero vendors.
   */
  @Get('synced-vendors')
  @Roles(UserRole.BRAND)
  @HttpCode(HttpStatus.OK)
  async getSyncedVendors() {
    const vendors = await this.connectionsService.getSyncedVendors();
    return { success: true, data: vendors };
  }

  /**
   * Sends connection requests or email invitations.
   */
  @Post('request')
  @Roles(UserRole.BRAND, UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async requestConnection(
    @Req() req: any,
    @Body('email') email: string,
    @Body('type') type: string
  ) {
    const senderId = req.user.userId;
    const result = await this.connectionsService.sendConnectionRequest(senderId, email, type);
    return { success: true, data: result };
  }

  /**
   * Lists incoming connection requests.
   */
  @Get('incoming')
  @Roles(UserRole.BRAND, UserRole.AGENCY, UserRole.TALENT)
  @HttpCode(HttpStatus.OK)
  async getIncoming(@Req() req: any) {
    const userId = req.user.userId;
    const incoming = await this.connectionsService.getIncomingConnections(userId);
    return { success: true, data: incoming };
  }

  /**
   * Lists outgoing connection requests/invitations.
   */
  @Get('outgoing')
  @Roles(UserRole.BRAND, UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async getOutgoing(@Req() req: any) {
    const userId = req.user.userId;
    const outgoing = await this.connectionsService.getOutgoingConnections(userId);
    return { success: true, data: outgoing };
  }

  /**
   * Accepts connection request.
   */
  @Post(':id/accept')
  @Roles(UserRole.BRAND, UserRole.AGENCY, UserRole.TALENT)
  @HttpCode(HttpStatus.OK)
  async accept(@Req() req: any, @Param('id') id: string) {
    const userId = req.user.userId;
    const result = await this.connectionsService.acceptConnection(userId, id);
    return { success: true, data: result };
  }

  /**
   * Declines connection request.
   */
  @Post(':id/decline')
  @Roles(UserRole.BRAND, UserRole.AGENCY, UserRole.TALENT)
  @HttpCode(HttpStatus.OK)
  async decline(@Req() req: any, @Param('id') id: string) {
    const userId = req.user.userId;
    const result = await this.connectionsService.declineConnection(userId, id);
    return { success: true, data: result };
  }

  /**
   * Cancels outgoing connection request.
   */
  @Post(':id/cancel')
  @Roles(UserRole.BRAND, UserRole.AGENCY)
  @HttpCode(HttpStatus.OK)
  async cancel(@Req() req: any, @Param('id') id: string) {
    const userId = req.user.userId;
    const result = await this.connectionsService.cancelConnection(userId, id);
    return { success: true, data: result };
  }

  /**
   * Removes relationship (un-links).
   */
  @Delete('relationship/:id')
  @Roles(UserRole.BRAND, UserRole.AGENCY, UserRole.TALENT)
  @HttpCode(HttpStatus.OK)
  async remove(@Req() req: any, @Param('id') id: string) {
    const userId = req.user.userId;
    const result = await this.connectionsService.removeConnection(userId, id);
    return { success: true, data: result };
  }

  /**
   * Lists connected partners (Brands, Agencies, Creators).
   */
  @Get('partners')
  @Roles(UserRole.BRAND, UserRole.AGENCY, UserRole.TALENT)
  @HttpCode(HttpStatus.OK)
  async getPartners(@Req() req: any) {
    const userId = req.user.userId;
    const partners = await this.connectionsService.getConnectedPartners(userId);
    return { success: true, data: partners };
  }

  /**
   * Lists in-app notifications.
   */
  @Get('notifications')
  @Roles(UserRole.BRAND, UserRole.AGENCY, UserRole.TALENT)
  @HttpCode(HttpStatus.OK)
  async getNotifications(@Req() req: any) {
    const userId = req.user.userId;
    const notifications = await this.connectionsService.getNotifications(userId);
    return { success: true, data: notifications };
  }

  /**
   * Marks notifications read.
   */
  @Post('notifications/read')
  @Roles(UserRole.BRAND, UserRole.AGENCY, UserRole.TALENT)
  @HttpCode(HttpStatus.OK)
  async markRead(@Req() req: any) {
    const userId = req.user.userId;
    const result = await this.connectionsService.markNotificationsRead(userId);
    return { success: true, data: result };
  }
}
