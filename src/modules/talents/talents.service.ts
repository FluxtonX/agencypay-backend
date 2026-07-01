import { Injectable, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import * as crypto from 'crypto';

@Injectable()
export class TalentsService {
  private readonly logger = new Logger(TalentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Invites a talent by email.
   */
  async inviteTalent(agencyId: string, email: string) {
    const cleanEmail = email.trim().toLowerCase();

    // Check if there's already an active relationship
    const talentUser = await this.prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (talentUser) {
      if (talentUser.role !== 'talent') {
        throw new BadRequestException(`User with email ${cleanEmail} is not a Talent (role: ${talentUser.role})`);
      }

      const existingRelationship = await this.prisma.relationship.findUnique({
        where: {
          roleAId_roleBId: {
            roleAId: agencyId,
            roleBId: talentUser.id,
          },
        },
      });

      if (existingRelationship) {
        throw new ConflictException(`You are already connected with this talent.`);
      }
    }

    // Check if a pending invitation already exists
    const existingInvitation = await this.prisma.connection.findFirst({
      where: {
        senderId: agencyId,
        email: cleanEmail,
        status: 'PENDING',
        type: 'AGENCY_TO_TALENT',
      },
    });

    if (existingInvitation) {
      throw new ConflictException(`An invitation has already been sent to this email and is pending.`);
    }

    // Create the invitation
    const token = crypto.randomBytes(32).toString('hex');
    const invitation = await this.prisma.connection.create({
      data: {
        senderId: agencyId,
        receiverId: talentUser ? talentUser.id : null,
        email: cleanEmail,
        status: 'PENDING',
        type: 'AGENCY_TO_TALENT',
        token,
      },
    });

    if (talentUser) {
      await this.prisma.notification.create({
        data: {
          userId: talentUser.id,
          title: 'Agency Connection Request',
          message: 'An agency has sent you a connection request.'
        }
      });
    }

    this.logger.log(`Agency ${agencyId} successfully invited talent ${cleanEmail}`);
    return invitation;
  }

  /**
   * Resends a pending or expired invitation.
   */
  async resendInvitation(agencyId: string, invitationId: string) {
    const invitation = await this.prisma.connection.findFirst({
      where: {
        id: invitationId,
        senderId: agencyId,
        type: 'AGENCY_TO_TALENT',
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

    this.logger.log(`Agency ${agencyId} resent invitation to ${invitation.email}`);
    return updatedInvitation;
  }

  /**
   * Cancels a pending invitation.
   */
  async cancelInvitation(agencyId: string, invitationId: string) {
    const invitation = await this.prisma.connection.findFirst({
      where: {
        id: invitationId,
        senderId: agencyId,
        type: 'AGENCY_TO_TALENT',
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

    this.logger.log(`Agency ${agencyId} cancelled invitation to ${invitation.email}`);
    return { success: true };
  }

  /**
   * Lists all invitations sent by an agency.
   */
  async getInvitations(agencyId: string) {
    return this.prisma.connection.findMany({
      where: {
        senderId: agencyId,
        type: 'AGENCY_TO_TALENT',
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lists all connected talents for an agency.
   */
  async getConnectedTalents(agencyId: string) {
    const relationships = await this.prisma.relationship.findMany({
      where: {
        roleAId: agencyId,
        type: 'AGENCY_TALENT',
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
   * Sandbox only: Simulates a talent accepting an invitation.
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
      let talentUser = await tx.user.findUnique({
        where: { email: invitation.email },
      });

      if (!talentUser) {
        const wallet = await tx.wallet.create({
          data: {
            type: 'INDIVIDUAL',
            name: `${invitation.email.split('@')[0].toUpperCase()} WALLET`,
            email: invitation.email,
          },
        });

        talentUser = await tx.user.create({
          data: {
            email: invitation.email,
            fullName: `${invitation.email.split('@')[0].toUpperCase()} CREATOR`,
            passwordHash: 'mock-sandbox-talent-password-hash',
            role: 'talent',
            walletId: wallet.id,
          },
        });
      }

      const relationship = await tx.relationship.create({
        data: {
          roleAId: invitation.senderId,
          roleBId: talentUser.id,
          type: 'AGENCY_TALENT',
        },
      });

      await tx.connection.update({
        where: { id: invitationId },
        data: {
          status: 'ACCEPTED',
          receiverId: talentUser.id,
        },
      });

      await tx.notification.create({
        data: {
          userId: invitation.senderId,
          title: 'Invitation Accepted',
          message: `${talentUser.fullName} accepted your connection request!`
        }
      });

      this.logger.log(`Sandbox: Invitation ${invitationId} accepted by talent ${talentUser.email}`);
      return relationship;
    });
  }
}
