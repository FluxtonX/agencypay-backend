import { Injectable, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import * as crypto from 'crypto';

@Injectable()
export class AgenciesService {
  private readonly logger = new Logger(AgenciesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Invites an agency by email.
   */
  async inviteAgency(brandId: string, email: string) {
    const cleanEmail = email.trim().toLowerCase();

    // Check if there's already an active relationship
    const agencyUser = await this.prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (agencyUser) {
      if (agencyUser.role !== 'agency') {
        throw new BadRequestException(`User with email ${cleanEmail} is not an Agency (role: ${agencyUser.role})`);
      }

      const existingRelationship = await this.prisma.relationship.findUnique({
        where: {
          roleAId_roleBId: {
            roleAId: brandId,
            roleBId: agencyUser.id,
          },
        },
      });

      if (existingRelationship) {
        throw new ConflictException(`You are already connected with this agency.`);
      }
    }

    // Check if a pending invitation already exists
    const existingInvitation = await this.prisma.connection.findFirst({
      where: {
        senderId: brandId,
        email: cleanEmail,
        status: 'PENDING',
        type: 'BRAND_TO_AGENCY',
      },
    });

    if (existingInvitation) {
      throw new ConflictException(`An invitation has already been sent to this email and is pending.`);
    }

    // Create the connection
    const token = crypto.randomBytes(32).toString('hex');
    const invitation = await this.prisma.connection.create({
      data: {
        senderId: brandId,
        receiverId: agencyUser ? agencyUser.id : null,
        email: cleanEmail,
        status: 'PENDING',
        type: 'BRAND_TO_AGENCY',
        token,
      },
    });

    if (agencyUser) {
      await this.prisma.notification.create({
        data: {
          userId: agencyUser.id,
          title: 'Brand Connection Request',
          message: 'A brand has sent you a connection request.'
        }
      });
    }

    this.logger.log(`Brand ${brandId} successfully invited agency ${cleanEmail}`);
    return invitation;
  }

  /**
   * Resends a pending or expired invitation.
   */
  async resendInvitation(brandId: string, invitationId: string) {
    const invitation = await this.prisma.connection.findFirst({
      where: {
        id: invitationId,
        senderId: brandId,
        type: 'BRAND_TO_AGENCY',
      },
    });

    if (!invitation) {
      throw new NotFoundException(`Invitation not found.`);
    }

    if (invitation.status === 'ACCEPTED') {
      throw new BadRequestException(`Invitation has already been accepted.`);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const updatedInvitation = await this.prisma.connection.update({
      where: { id: invitationId },
      data: {
        status: 'PENDING',
        token,
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Brand ${brandId} resent invitation to ${invitation.email}`);
    return updatedInvitation;
  }

  /**
   * Cancels a pending invitation.
   */
  async cancelInvitation(brandId: string, invitationId: string) {
    const invitation = await this.prisma.connection.findFirst({
      where: {
        id: invitationId,
        senderId: brandId,
        type: 'BRAND_TO_AGENCY',
      },
    });

    if (!invitation) {
      throw new NotFoundException(`Invitation not found.`);
    }

    if (invitation.status === 'ACCEPTED') {
      throw new BadRequestException(`Cannot cancel an already accepted invitation.`);
    }

    await this.prisma.connection.update({
      where: { id: invitationId },
      data: { status: 'CANCELLED' }
    });

    this.logger.log(`Brand ${brandId} cancelled invitation to ${invitation.email}`);
    return { success: true };
  }

  /**
   * Lists all invitations sent by a brand.
   */
  async getInvitations(brandId: string) {
    return this.prisma.connection.findMany({
      where: {
        senderId: brandId,
        type: 'BRAND_TO_AGENCY',
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lists all connected agencies for a brand.
   */
  async getConnectedAgencies(brandId: string) {
    const relationships = await this.prisma.relationship.findMany({
      where: {
        roleAId: brandId,
        type: 'BRAND_AGENCY',
      },
      include: {
        roleB: {
          select: {
            id: true,
            email: true,
            fullName: true,
            walletId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return relationships.map((rel) => ({
      relationshipId: rel.id,
      connectedAt: rel.createdAt,
      id: rel.roleB.id,
      email: rel.roleB.email,
      fullName: rel.roleB.fullName,
      walletId: rel.roleB.walletId,
    }));
  }

  /**
   * Sandbox only: Simulates an agency accepting an invitation.
   */
  async acceptInvitationSandbox(invitationId: string) {
    const invitation = await this.prisma.connection.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundException(`Invitation not found.`);
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`Invitation is not pending (status: ${invitation.status})`);
    }

    return this.prisma.$transaction(async (tx) => {
      let agencyUser = await tx.user.findUnique({
        where: { email: invitation.email },
      });

      if (!agencyUser) {
        const wallet = await tx.wallet.create({
          data: {
            type: 'BUSINESS',
            name: `${invitation.email.split('@')[0].toUpperCase()} AGENCY WALLET`,
            email: invitation.email,
          },
        });

        agencyUser = await tx.user.create({
          data: {
            email: invitation.email,
            fullName: `${invitation.email.split('@')[0].toUpperCase()} AGENCY`,
            passwordHash: 'mock-sandbox-agency-password-hash',
            role: 'agency',
            walletId: wallet.id,
          },
        });
      }

      const relationship = await tx.relationship.create({
        data: {
          roleAId: invitation.senderId,
          roleBId: agencyUser.id,
          type: 'BRAND_AGENCY',
        },
      });

      await tx.connection.update({
        where: { id: invitationId },
        data: {
          status: 'ACCEPTED',
          receiverId: agencyUser.id,
        },
      });

      await tx.notification.create({
        data: {
          userId: invitation.senderId,
          title: 'Invitation Accepted',
          message: `${agencyUser.fullName} accepted your connection request!`
        }
      });

      this.logger.log(`Sandbox: Invitation ${invitationId} accepted by agency ${agencyUser.email}`);
      return relationship;
    });
  }

  /**
   * Lists all connected brands for an agency.
   */
  async getConnectedBrands(agencyId: string) {
    const relationships = await this.prisma.relationship.findMany({
      where: {
        roleBId: agencyId,
        type: 'BRAND_AGENCY',
      },
      include: {
        roleA: {
          select: {
            id: true,
            email: true,
            fullName: true,
            walletId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return relationships.map((rel) => ({
      relationshipId: rel.id,
      connectedAt: rel.createdAt,
      id: rel.roleA.id,
      email: rel.roleA.email,
      fullName: rel.roleA.fullName,
      walletId: rel.roleA.walletId,
    }));
  }

  /**
   * Lists all incoming invitations for an agency by email.
   */
  async getIncomingInvitations(email: string) {
    return this.prisma.connection.findMany({
      where: {
        email: email.trim().toLowerCase(),
        status: 'PENDING',
        type: 'BRAND_TO_AGENCY',
      },
      include: {
        sender: {
          select: {
            fullName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Accepts a brand invitation.
   */
  async acceptInvitation(agencyId: string, invitationId: string) {
    const invitation = await this.prisma.connection.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundException(`Invitation not found.`);
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`Invitation is not pending (status: ${invitation.status})`);
    }

    return this.prisma.$transaction(async (tx) => {
      const relationship = await tx.relationship.create({
        data: {
          roleAId: invitation.senderId,
          roleBId: agencyId,
          type: 'BRAND_AGENCY',
        },
      });

      await tx.connection.update({
        where: { id: invitationId },
        data: {
          status: 'ACCEPTED',
          receiverId: agencyId,
        },
      });

      const receiver = await tx.user.findUnique({ where: { id: agencyId } });
      await tx.notification.create({
        data: {
          userId: invitation.senderId,
          title: 'Invitation Accepted',
          message: `${receiver?.fullName || 'An agency'} accepted your connection request!`
        }
      });

      this.logger.log(`Agency ${agencyId} accepted invitation ${invitationId}`);
      return relationship;
    });
  }
}
