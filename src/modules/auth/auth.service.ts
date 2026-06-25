import { Injectable, ConflictException, UnauthorizedException, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto, LoginDto } from './dto/auth.dto.js';
import { WalletType } from '@prisma/client';
import { UserRole } from '../../common/constants/roles.js';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Hashes a password using PBKDF2.
   */
  private hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  /**
   * Verifies a password against a stored hash.
   */
  private verifyPassword(password: string, storedHash: string): boolean {
    const [salt, hash] = storedHash.split(':');
    const checkHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return hash === checkHash;
  }

  /**
   * Registers a new user, hashes their password, and provisions a Wallet + accounts.
   */
  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();

    // 1. Check if user already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException(`User with email ${email} already exists`);
    }

    // 2. Hash password
    const passwordHash = this.hashPassword(dto.password);

    // 3. Create user and provision Wallet/Accounts in a transaction
    return this.prisma.$transaction(async (tx) => {
      // Determine wallet type based on role
      const walletType = dto.roleType === 'talent' ? WalletType.INDIVIDUAL : WalletType.BUSINESS;
      const walletName = dto.roleType === 'talent' ? fullName : (dto.workspaceName || `${fullName}'s Workspace`).trim();

      // Create internal wallet using WalletService (we pass the transaction context where possible, 
      // but walletService.createWallet manages its own Prisma context. To run atomically, we can 
      // inline wallet creation or invoke walletService. Let's call walletService).
      const walletData = await this.walletService.createWallet({
        type: walletType,
        name: walletName,
        email: email,
      });

      // Create the user linked to the new wallet
      const user = await tx.user.create({
        data: {
          email,
          fullName,
          passwordHash,
          role: dto.roleType,
          walletId: walletData.id,
        },
      });

      this.logger.log(`Successfully registered user ${email} with wallet ${walletData.id}`);

      return {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        walletId: user.walletId,
      };
    });
  }

  /**
   * Logs a user in, verifies credentials, and returns a JWT access token.
   */
  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();

    // 1. Find user
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // 2. Verify password
    const isPasswordValid = this.verifyPassword(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // 3. Sign token
    // Match the roles structure expected by roles.guard.ts and jwt.strategy.ts.
    // user.role is "brand" | "agency" | "talent"
    // UserRole enum in prisma matches: 'admin', 'platform', 'brand', 'agency', 'talent'
    const payload = {
      sub: user.id,
      email: user.email,
      roles: [user.role],
      walletId: user.walletId,
    };

    const token = this.jwtService.sign(payload);

    this.logger.log(`Successfully authenticated user ${email}`);

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        walletId: user.walletId,
      },
    };
  }
}
