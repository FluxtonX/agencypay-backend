import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { IdempotencyService } from './idempotency.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  const mockPrisma = {
    idempotencyKey: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const mockConfig = {
    get: jest.fn().mockReturnValue(86400),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<IdempotencyService>(IdempotencyService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // check
  // ========================================================================
  describe('check', () => {
    it('should return isNew=true for new key', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
      mockPrisma.idempotencyKey.create.mockResolvedValue({});

      const result = await service.check('key1', 'POST', '/payments');

      expect(result.isNew).toBe(true);
      expect(result.response).toBeUndefined();
      expect(mockPrisma.idempotencyKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ key: 'key1', method: 'POST', path: '/payments' }),
        }),
      );
    });

    it('should return cached response for completed key', async () => {
      const cachedResponse = { id: 'payment-1', status: 'SETTLED' };
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue({
        key: 'key1',
        statusCode: 201,
        response: cachedResponse,
        expiresAt: new Date(Date.now() + 100000),
      });

      const result = await service.check('key1', 'POST', '/payments');

      expect(result.isNew).toBe(false);
      expect(result.response).toEqual(cachedResponse);
    });

    it('should throw ConflictException if key is in-progress', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue({
        key: 'key1',
        statusCode: null,
        response: null,
        expiresAt: new Date(Date.now() + 100000),
      });

      await expect(
        service.check('key1', 'POST', '/payments'),
      ).rejects.toThrow(ConflictException);
    });

    it('should allow reuse of expired keys', async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue({
        key: 'key1',
        statusCode: 201,
        response: { old: true },
        expiresAt: new Date(Date.now() - 1000), // Expired
      });
      mockPrisma.idempotencyKey.delete.mockResolvedValue({});
      mockPrisma.idempotencyKey.create.mockResolvedValue({});

      const result = await service.check('key1', 'POST', '/payments');

      expect(result.isNew).toBe(true);
      expect(mockPrisma.idempotencyKey.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: 'key1' } }),
      );
    });
  });

  // ========================================================================
  // complete
  // ========================================================================
  describe('complete', () => {
    it('should update key with response data', async () => {
      mockPrisma.idempotencyKey.update.mockResolvedValue({});

      await service.complete('key1', 201, { id: 'result' });

      expect(mockPrisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: 'key1' },
        data: { statusCode: 201, response: { id: 'result' } },
      });
    });
  });

  // ========================================================================
  // remove
  // ========================================================================
  describe('remove', () => {
    it('should delete the key', async () => {
      mockPrisma.idempotencyKey.deleteMany.mockResolvedValue({});

      await service.remove('key1');

      expect(mockPrisma.idempotencyKey.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: 'key1' } }),
      );
    });
  });
});
