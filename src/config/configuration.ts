export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  database: {
    url: process.env.DATABASE_URL,
  },
  quickbooks: {
    clientId: process.env.QUICKBOOKS_CLIENT_ID || '',
    clientSecret: process.env.QUICKBOOKS_CLIENT_SECRET || '',
    webhookToken: process.env.QUICKBOOKS_WEBHOOK_TOKEN || '',
    baseUrl:
      process.env.QUICKBOOKS_BASE_URL ||
      'https://sandbox-quickbooks.api.intuit.com',
    environment: process.env.QUICKBOOKS_ENV || 'sandbox',
  },
  column: {
    apiKey: process.env.COLUMN_API_KEY || '',
    baseUrl: process.env.COLUMN_BASE_URL || 'https://api.column.com',
    webhookSecret: process.env.COLUMN_WEBHOOK_SECRET || '',
  },
  credit: {
    maxExposureMultiplier: parseFloat(
      process.env.CREDIT_MAX_EXPOSURE_MULTIPLIER || '0.8',
    ),
    defaultInterestRate: parseFloat(
      process.env.CREDIT_DEFAULT_INTEREST_RATE || '0.0',
    ),
    minScoreForApproval: parseInt(
      process.env.CREDIT_MIN_SCORE_APPROVAL || '60',
      10,
    ),
    minScoreForPartial: parseInt(
      process.env.CREDIT_MIN_SCORE_PARTIAL || '40',
      10,
    ),
  },
  idempotency: {
    ttlSeconds: parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10), // 24h
  },
});
