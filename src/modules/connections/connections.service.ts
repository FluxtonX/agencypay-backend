import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { QuickBooksService } from '../../integrations/quickbooks/quickbooks.service.js';
import { XeroService } from '../../integrations/xero/xero.service.js';
import * as crypto from 'crypto';

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quickBooksService: QuickBooksService,
    private readonly xeroService: XeroService
  ) {}

  /**
   * Retrieves synced vendors from QuickBooks/Xero and matches them to registered users.
   */
  async getSyncedVendors() {
    const list: any[] = [];

    // QuickBooks Online
    try {
      const qboData = await this.quickBooksService.getVendors();
      if (qboData?.connected && qboData.vendors) {
        for (const v of qboData.vendors) {
          if (!v.email) continue;
          list.push({
            id: v.id,
            name: v.name,
            email: v.email.toLowerCase(),
            provider: 'QuickBooks'
          });
        }
      }
    } catch (err: any) {
      this.logger.error('Error matching QBO vendors', err.message);
    }

    // Xero
    try {
      const xeroData = await this.xeroService.getVendors();
      if (xeroData?.connected && xeroData.vendors) {
        for (const v of xeroData.vendors) {
          if (!v.EmailAddress) continue;
          list.push({
            id: v.ContactID,
            name: v.Name,
            email: v.EmailAddress.toLowerCase(),
            provider: 'Xero'
          });
        }
      }
    } catch (err: any) {
      this.logger.error('Error matching Xero vendors', err.message);
    }

    // Match to registered users & active relationships
    const matchedVendors: any[] = [];
    for (const item of list) {
      const user = await this.prisma.user.findUnique({
        where: { email: item.email },
        select: { id: true, email: true, fullName: true, role: true }
      });

      let status = 'INVITE'; // Default action is invite
      let connectionId: string | undefined;

      if (user) {
        status = 'CONNECT'; // User exists, can send direct connection request
        
        // Check if there is already a pending connection
        const conn = await this.prisma.connection.findFirst({
          where: {
            email: item.email,
            status: { in: ['PENDING', 'ACCEPTED'] }
          }
        });
        if (conn) {
          status = conn.status;
          connectionId = conn.id;
        }
      } else {
        // Unregistered, check if already invited
        const conn = await this.prisma.connection.findFirst({
          where: {
            email: item.email,
            status: 'PENDING'
          }
        });
        if (conn) {
          status = 'PENDING';
          connectionId = conn.id;
        }
      }

      matchedVendors.push({
        ...item,
        registered: !!user,
        status,
        connectionId,
        user
      });
    }

    return matchedVendors;
  }

  /**
   * Search registered users by email or fullName.
   */
  async searchUsers(query: string, currentUserId: string, currentUserRole: string) {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    let allowedRoles: string[] = [];
    if (currentUserRole === 'brand') {
      allowedRoles = ['agency', 'talent'];
    } else if (currentUserRole === 'agency') {
      allowedRoles = ['talent'];
    } else {
      return [];
    }

    return this.prisma.user.findMany({
      where: {
        id: { not: currentUserId },
        role: { in: allowedRoles },
        OR: [
          { email: { contains: cleanQuery, mode: 'insensitive' } },
          { fullName: { contains: cleanQuery, mode: 'insensitive' } }
        ]
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        walletId: true
      },
      take: 10
    });
  }

  async sendConnectionRequest(senderId: string, email: string, type: string) {
    const targetEmail = email.trim().toLowerCase();
    const allowedTypes = ['BRAND_TO_AGENCY', 'BRAND_TO_TALENT', 'AGENCY_TO_TALENT'];
    if (!allowedTypes.includes(type)) {
      throw new BadRequestException('Invalid connection type requested');
    }

    // 1. Fetch sender profile
    const sender = await this.prisma.user.findUnique({
      where: { id: senderId }
    });
    if (!sender) throw new NotFoundException('Sender user not found');

    // 2. Check if the receiver is already registered
    const receiver = await this.prisma.user.findUnique({
      where: { email: targetEmail }
    });

    if (receiver) {
      if (receiver.id === senderId) {
        throw new BadRequestException('You cannot connect with yourself');
      }

      // Validate roles align with the connection request type
      if (type === 'BRAND_TO_AGENCY' && (sender.role !== 'brand' || receiver.role !== 'agency')) {
        throw new BadRequestException('Roles do not align with BRAND_TO_AGENCY connection');
      }
      if (type === 'BRAND_TO_TALENT' && (sender.role !== 'brand' || receiver.role !== 'talent')) {
        throw new BadRequestException('Roles do not align with BRAND_TO_TALENT connection');
      }
      if (type === 'AGENCY_TO_TALENT' && (sender.role !== 'agency' || receiver.role !== 'talent')) {
        throw new BadRequestException('Roles do not align with AGENCY_TO_TALENT connection');
      }

      // Check if relationship already exists
      const roleAId = sender.role === 'brand' || (sender.role === 'agency' && receiver.role === 'talent') ? sender.id : receiver.id;
      const roleBId = sender.role === 'brand' || (sender.role === 'agency' && receiver.role === 'talent') ? receiver.id : sender.id;

      const existingRel = await this.prisma.relationship.findUnique({
        where: { roleAId_roleBId: { roleAId, roleBId } }
      });
      if (existingRel) {
        throw new ConflictException('An active relationship already exists with this user');
      }
    }

    // 3. Check unique connection constraint in the database
    const existingConn = await this.prisma.connection.findUnique({
      where: {
        senderId_email: {
          senderId,
          email: targetEmail
        }
      }
    });

    const token = crypto.randomBytes(32).toString('hex');

    if (existingConn) {
      if (existingConn.status === 'PENDING' || existingConn.status === 'ACCEPTED') {
        throw new ConflictException(`A connection request is already ${existingConn.status.toLowerCase()}`);
      }

      // Re-activate connection: update status back to PENDING with a new token
      const connection = await this.prisma.connection.update({
        where: { id: existingConn.id },
        data: {
          status: 'PENDING',
          token,
          type,
          receiverId: receiver ? receiver.id : null
        }
      });

      if (receiver) {
        // Create notification for receiver
        await this.prisma.notification.create({
          data: {
            userId: receiver.id,
            title: 'New Connection Request',
            message: `${sender.fullName} (${sender.role.toUpperCase()}) wants to connect with your workspace.`
          }
        });
      }

      this.logger.log(`Re-activated invitation/request for ${targetEmail}`);
      return { success: true, registered: !!receiver, connection };
    }

    // Create fresh connection request
    const connection = await this.prisma.connection.create({
      data: {
        senderId,
        receiverId: receiver ? receiver.id : null,
        email: targetEmail,
        type,
        token,
        status: 'PENDING'
      }
    });

    if (receiver) {
      // Create notification for receiver
      await this.prisma.notification.create({
        data: {
          userId: receiver.id,
          title: 'New Connection Request',
          message: `${sender.fullName} (${sender.role.toUpperCase()}) wants to connect with your workspace.`
        }
      });
    }

    this.logger.log(`Fresh connection invitation generated for ${targetEmail}`);
    return { success: true, registered: !!receiver, connection };
  }

  /**
   * Retrieves incoming requests for the logged-in user.
   */
  async getIncomingConnections(userId: string) {
    return this.prisma.connection.findMany({
      where: {
        receiverId: userId,
        status: 'PENDING'
      },
      include: {
        sender: {
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Retrieves outgoing requests sent by the logged-in user.
   */
  async getOutgoingConnections(userId: string) {
    return this.prisma.connection.findMany({
      where: { senderId: userId },
      include: {
        receiver: {
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Accepts an incoming connection request.
   */
  async acceptConnection(userId: string, connectionId: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId }
    });

    if (!connection) throw new NotFoundException('Connection request not found');
    if (connection.receiverId !== userId) {
      throw new BadRequestException('You do not have permission to accept this connection');
    }
    if (connection.status !== 'PENDING') {
      throw new BadRequestException(`Connection is already ${connection.status.toLowerCase()}`);
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Update status
      const updatedConn = await tx.connection.update({
        where: { id: connectionId },
        data: { status: 'ACCEPTED' }
      });

      // Determine Relationship Role A and Role B
      // BRAND_TO_AGENCY -> roleA = Brand, roleB = Agency
      // BRAND_TO_TALENT -> roleA = Brand, roleB = Talent
      // AGENCY_TO_TALENT -> roleA = Agency, roleB = Talent
      let roleAId: string;
      let roleBId: string;
      let relType: string;

      if (connection.type === 'BRAND_TO_AGENCY') {
        roleAId = connection.senderId;
        roleBId = connection.receiverId!;
        relType = 'BRAND_AGENCY';
      } else if (connection.type === 'BRAND_TO_TALENT') {
        roleAId = connection.senderId;
        roleBId = connection.receiverId!;
        relType = 'BRAND_TALENT';
      } else {
        roleAId = connection.senderId;
        roleBId = connection.receiverId!;
        relType = 'AGENCY_TALENT';
      }

      // 2. Create relationship
      const relationship = await tx.relationship.create({
        data: {
          roleAId,
          roleBId,
          type: relType
        }
      });

      // 3. Notify sender
      const receiver = await tx.user.findUnique({ where: { id: userId } });
      await tx.notification.create({
        data: {
          userId: connection.senderId,
          title: 'Invitation Accepted',
          message: `${receiver?.fullName || 'A partner'} accepted your connection request!`
        }
      });

      return { connection: updatedConn, relationship };
    });
  }

  /**
   * Declines an incoming connection request.
   */
  async declineConnection(userId: string, connectionId: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId }
    });

    if (!connection) throw new NotFoundException('Connection request not found');
    if (connection.receiverId !== userId) {
      throw new BadRequestException('You do not have permission to decline this connection');
    }
    if (connection.status !== 'PENDING') {
      throw new BadRequestException(`Connection is already ${connection.status.toLowerCase()}`);
    }

    const updatedConn = await this.prisma.connection.update({
      where: { id: connectionId },
      data: { status: 'DECLINED' }
    });

    const receiver = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.prisma.notification.create({
      data: {
        userId: connection.senderId,
        title: 'Invitation Declined',
        message: `${receiver?.fullName || 'A partner'} declined your connection request.`
      }
    });

    return updatedConn;
  }

  /**
   * Cancels a sent connection request.
   */
  async cancelConnection(userId: string, connectionId: string) {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId }
    });

    if (!connection) throw new NotFoundException('Connection request not found');
    if (connection.senderId !== userId) {
      throw new BadRequestException('You did not send this connection request');
    }
    if (connection.status !== 'PENDING') {
      throw new BadRequestException(`Connection is already ${connection.status.toLowerCase()}`);
    }

    return this.prisma.connection.update({
      where: { id: connectionId },
      data: { status: 'CANCELLED' }
    });
  }

  /**
   * Removes a connection (disconnect active relationship).
   */
  async removeConnection(userId: string, relationshipId: string) {
    const rel = await this.prisma.relationship.findUnique({
      where: { id: relationshipId }
    });

    if (!rel) throw new NotFoundException('Relationship not found');
    if (rel.roleAId !== userId && rel.roleBId !== userId) {
      throw new BadRequestException('You are not a member of this relationship');
    }

    const targetUserId = rel.roleAId === userId ? rel.roleBId : rel.roleAId;

    return this.prisma.$transaction(async (tx) => {
      // Delete Relationship
      await tx.relationship.delete({
        where: { id: relationshipId }
      });

      // Find the corresponding connection request and update it to CANCELLED or delete
      await tx.connection.deleteMany({
        where: {
          OR: [
            { senderId: rel.roleAId, receiverId: rel.roleBId },
            { senderId: rel.roleBId, receiverId: rel.roleAId }
          ]
        }
      });

      const user = await tx.user.findUnique({ where: { id: userId } });
      await tx.notification.create({
        data: {
          userId: targetUserId,
          title: 'Connection Removed',
          message: `${user?.fullName || 'A partner'} disconnected the workspace relationship.`
        }
      });

      return { success: true };
    });
  }

  /**
   * Retrieves active connected accounts for a given user role.
   */
  async getConnectedPartners(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (user.role === 'brand') {
      // Find all relationships where roleAId === userId
      const rels = await this.prisma.relationship.findMany({
        where: { roleAId: userId },
        include: {
          roleB: {
            select: { id: true, email: true, fullName: true, role: true, walletId: true }
          }
        }
      });
      return rels.map(r => ({
        relationshipId: r.id,
        connectedAt: r.createdAt,
        partner: r.roleB
      }));
    } else if (user.role === 'talent') {
      // Find all relationships where roleBId === userId
      const rels = await this.prisma.relationship.findMany({
        where: { roleBId: userId },
        include: {
          roleA: {
            select: { id: true, email: true, fullName: true, role: true, walletId: true }
          }
        }
      });
      return rels.map(r => ({
        relationshipId: r.id,
        connectedAt: r.createdAt,
        partner: r.roleA
      }));
    } else {
      // Agency can be either roleA (with Talents) or roleB (with Brands)
      const relsA = await this.prisma.relationship.findMany({
        where: { roleAId: userId },
        include: {
          roleB: {
            select: { id: true, email: true, fullName: true, role: true, walletId: true }
          }
        }
      });
      const relsB = await this.prisma.relationship.findMany({
        where: { roleBId: userId },
        include: {
          roleA: {
            select: { id: true, email: true, fullName: true, role: true, walletId: true }
          }
        }
      });

      const partners = [
        ...relsA.map(r => ({ relationshipId: r.id, connectedAt: r.createdAt, partner: r.roleB })),
        ...relsB.map(r => ({ relationshipId: r.id, connectedAt: r.createdAt, partner: r.roleA }))
      ];

      return partners;
    }
  }

  /**
   * Retrieves in-app notifications.
   */
  async getNotifications(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
  }

  /**
   * Marks all user notifications as read.
   */
  async markNotificationsRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true }
    });
    return { success: true };
  }
}
