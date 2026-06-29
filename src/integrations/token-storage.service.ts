import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const INTEGRATIONS_FILE = path.join(DATA_DIR, 'integrations.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getEncryptionKey(): Buffer {
  const raw =
    process.env.ENCRYPTION_KEY ||
    process.env.PLAID_SECRET ||
    'agncypay-fallback-encryption-secret-key-32';
  const cleaned = raw.replace(/^["']|["']$/g, '');
  return crypto.createHash('sha256').update(cleaned).digest();
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
}

function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted text format.');
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const authTag = Buffer.from(parts[2], 'hex');
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

interface IntegrationsStore {
  plaid?: {
    accessToken: string; // encrypted
    itemId: string;
    institutionName?: string;
    institutionId?: string;
    connectedAt: string;
  };
  quickbooks?: {
    access_token: string; // encrypted
    refresh_token?: string; // encrypted
    realmId?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    createdAt: number;
    token_type?: string;
  };
  xero?: {
    access_token: string; // encrypted
    refresh_token?: string; // encrypted
    tenantId?: string;
    expires_in?: number;
    createdAt: number;
    token_type?: string;
  };
}

@Injectable()
export class TokenStorageService {
  private readonly logger = new Logger(TokenStorageService.name);

  private readStore(): IntegrationsStore {
    ensureDataDir();
    if (!fs.existsSync(INTEGRATIONS_FILE)) return {};
    try {
      return JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, 'utf8')) as IntegrationsStore;
    } catch {
      return {};
    }
  }

  private writeStore(store: IntegrationsStore): void {
    ensureDataDir();
    fs.writeFileSync(INTEGRATIONS_FILE, JSON.stringify(store, null, 2), 'utf8');
  }

  // ─── Plaid ───────────────────────────────────────────────────────────────

  savePlaidToken(data: {
    accessToken: string;
    itemId: string;
    institutionName?: string;
    institutionId?: string;
  }): void {
    const store = this.readStore();
    store.plaid = {
      accessToken: encrypt(data.accessToken),
      itemId: data.itemId,
      institutionName: data.institutionName || 'Unknown Institution',
      institutionId: data.institutionId || '',
      connectedAt: new Date().toISOString(),
    };
    this.writeStore(store);
    this.logger.log('Plaid token saved.');
  }

  getPlaidToken(): {
    accessToken: string;
    itemId: string;
    institutionName?: string;
    institutionId?: string;
    connectedAt: string;
  } | null {
    const store = this.readStore();
    if (!store.plaid?.accessToken) return null;
    try {
      return {
        accessToken: decrypt(store.plaid.accessToken),
        itemId: store.plaid.itemId,
        institutionName: store.plaid.institutionName,
        institutionId: store.plaid.institutionId,
        connectedAt: store.plaid.connectedAt,
      };
    } catch (e) {
      this.logger.error('Failed to decrypt Plaid token', e);
      return null;
    }
  }

  clearPlaidToken(): void {
    const store = this.readStore();
    delete store.plaid;
    this.writeStore(store);
    this.logger.log('Plaid token cleared.');
  }

  // ─── QuickBooks ──────────────────────────────────────────────────────────

  saveQboToken(token: {
    access_token?: string;
    refresh_token?: string;
    realmId?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    token_type?: string;
  }): void {
    const store = this.readStore();
    store.quickbooks = {
      access_token: token.access_token ? encrypt(token.access_token) : '',
      refresh_token: token.refresh_token ? encrypt(token.refresh_token) : undefined,
      realmId: token.realmId,
      expires_in: token.expires_in,
      x_refresh_token_expires_in: token.x_refresh_token_expires_in,
      createdAt: Date.now(),
      token_type: token.token_type || 'bearer',
    };
    this.writeStore(store);
    this.logger.log('QuickBooks token saved.');
  }

  getQboToken(): {
    access_token?: string;
    refresh_token?: string;
    realmId?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    createdAt: number;
    token_type?: string;
  } | null {
    const store = this.readStore();
    if (!store.quickbooks?.access_token) return null;
    try {
      return {
        access_token: decrypt(store.quickbooks.access_token),
        refresh_token: store.quickbooks.refresh_token
          ? decrypt(store.quickbooks.refresh_token)
          : undefined,
        realmId: store.quickbooks.realmId,
        expires_in: store.quickbooks.expires_in,
        x_refresh_token_expires_in: store.quickbooks.x_refresh_token_expires_in,
        createdAt: store.quickbooks.createdAt,
        token_type: store.quickbooks.token_type,
      };
    } catch (e) {
      this.logger.error('Failed to decrypt QuickBooks token', e);
      return null;
    }
  }

  clearQboToken(): void {
    const store = this.readStore();
    delete store.quickbooks;
    this.writeStore(store);
    this.logger.log('QuickBooks token cleared.');
  }

  // ─── Xero ────────────────────────────────────────────────────────────────

  saveXeroToken(token: {
    access_token?: string;
    refresh_token?: string;
    tenantId?: string;
    expires_in?: number;
    token_type?: string;
  }): void {
    const store = this.readStore();
    store.xero = {
      access_token: token.access_token ? encrypt(token.access_token) : '',
      refresh_token: token.refresh_token ? encrypt(token.refresh_token) : undefined,
      tenantId: token.tenantId,
      expires_in: token.expires_in,
      createdAt: Date.now(),
      token_type: token.token_type || 'bearer',
    };
    this.writeStore(store);
    this.logger.log('Xero token saved.');
  }

  getXeroToken(): {
    access_token?: string;
    refresh_token?: string;
    tenantId?: string;
    expires_in?: number;
    createdAt: number;
    token_type?: string;
  } | null {
    const store = this.readStore();
    if (!store.xero?.access_token) return null;
    try {
      return {
        access_token: decrypt(store.xero.access_token),
        refresh_token: store.xero.refresh_token
          ? decrypt(store.xero.refresh_token)
          : undefined,
        tenantId: store.xero.tenantId,
        expires_in: store.xero.expires_in,
        createdAt: store.xero.createdAt,
        token_type: store.xero.token_type,
      };
    } catch (e) {
      this.logger.error('Failed to decrypt Xero token', e);
      return null;
    }
  }

  clearXeroToken(): void {
    const store = this.readStore();
    delete store.xero;
    this.writeStore(store);
    this.logger.log('Xero token cleared.');
  }
}
