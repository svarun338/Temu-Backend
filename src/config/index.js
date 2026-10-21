import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Load server/.env (tests configure process.env themselves before importing this module).
if (process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile(path.join(rootDir, '.env'));
  } catch {
    // No .env file: rely on real environment variables.
  }
}

const env = process.env;

function required(name) {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`Environment variable ${name} must be an integer`);
  return value;
}

const list = (raw) =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

// Running on a hosting platform? Then default to production even if NODE_ENV was forgotten.
const hosted = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RENDER || env.FLY_APP_NAME || env.DYNO);
const nodeEnv = env.NODE_ENV || (hosted ? 'production' : 'development');

const jwtSecret = required('JWT_ACCESS_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('JWT_ACCESS_SECRET must be at least 32 characters long');
}
if (/change-?me/i.test(jwtSecret)) {
  throw new Error('JWT_ACCESS_SECRET is still the example value. Generate a random one (see README).');
}

const storageDriver = env.STORAGE_DRIVER || 'local';
if (!['local', 's3'].includes(storageDriver)) throw new Error('STORAGE_DRIVER must be "local" or "s3"');
if (storageDriver === 's3' && !env.S3_BUCKET) throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET');

export const config = Object.freeze({
  rootDir,
  env: nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  hosted,
  port: int('PORT', 4000),
  trustProxy: int('TRUST_PROXY', 0),
  clientOrigins: (env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: int('DB_PORT', 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD ?? '',
    database: required('DB_NAME'),
    connectionLimit: int('DB_POOL_SIZE', 10),
    // TLS to the database (e.g. a managed MySQL reached over the internet).
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
    // Migrations need CREATE/ALTER; the app itself can run as a user without them.
    migrationUser: env.DB_MIGRATION_USER || '',
    migrationPassword: env.DB_MIGRATION_PASSWORD ?? '',
  },
  auth: {
    accessSecret: jwtSecret,
    accessTtl: env.JWT_ACCESS_TTL || '15m',
    issuer: 'temu-api',
    audience: 'temu-client',
    refreshTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 7),
    refreshCookieName: 'temu_refresh',
    mediaCookieName: 'temu_media',
    // A rotated refresh token is still honoured for this long so that parallel
    // tabs refreshing at the same moment do not log each other out.
    refreshReuseGraceMs: 30_000,
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
  },
  chat: {
    maxMessageLength: 4000,
    pageSize: 30,
    editWindowMinutes: 15,
    deleteForEveryoneHours: 48,
    maxPins: 3,
    maxForwardTargets: 5,
  },
  otp: {
    length: 6,
    ttlMinutes: int('OTP_TTL_MINUTES', 10),
    maxAttempts: 5,
    resendCooldownSeconds: int('OTP_RESEND_COOLDOWN_SECONDS', 60),
    // Show the code in API responses so the app works without an email server.
    // Opt-in for local development only: never in production or on a hosting platform.
    devDisplay: nodeEnv !== 'production' && !hosted && env.OTP_DEV_DISPLAY === 'true',
  },
  mail: {
    // Any SMTP server works (Gmail app password, Brevo/Mailjet free tier, a local Mailpit, …).
    host: env.SMTP_HOST || '',
    port: int('SMTP_PORT', 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    password: env.SMTP_PASSWORD || '',
    from: env.MAIL_FROM || 'TEMU <no-reply@temu.local>',
  },
  // Web Push (notifications when the app is closed). Generate keys with `npm run vapid`.
  push: {
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateKey: env.VAPID_PRIVATE_KEY || '',
    subject: env.VAPID_SUBJECT || 'mailto:admin@temu.local',
    get enabled() {
      return Boolean(this.publicKey && this.privateKey);
    },
  },
  // Voice/video calls. Media is peer to peer (WebRTC); these servers only help the two browsers find each other.
  calls: {
    ringTimeoutMs: int('CALL_RING_SECONDS', 35) * 1000,
    // How long a call survives its tab's socket reconnecting (e.g. the 15-minute token refresh).
    reconnectGraceMs: int('CALL_RECONNECT_GRACE_SECONDS', 20) * 1000,
    stunUrls: list(env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
    // Optional TURN relay (e.g. your own coturn) for networks where peer to peer is impossible.
    turnUrls: list(env.TURN_URLS ?? ''),
    // coturn "use-auth-secret": short-lived credentials are derived per user. Or a static username/credential.
    turnSecret: env.TURN_SECRET || '',
    turnUsername: env.TURN_USERNAME || '',
    turnCredential: env.TURN_CREDENTIAL || '',
    turnTtlSeconds: 12 * 3600,
    // Group calls are a mesh (everyone sends to everyone), so they stay small.
    maxGroupParticipants: int('MAX_GROUP_CALL_PARTICIPANTS', 6),
  },
  // GIF search (optional). Free key from developers.giphy.com; without it only "Recent GIFs" works.
  gifs: {
    giphyKey: env.GIPHY_API_KEY || '',
    rating: ['g', 'pg', 'pg-13', 'r'].includes(env.GIPHY_RATING) ? env.GIPHY_RATING : 'pg-13',
    maxBytes: 8 * 1024 * 1024,
    get enabled() {
      return Boolean(this.giphyKey);
    },
  },
  // End-to-end encryption. With `required`, the server refuses plaintext chat messages
  // (the app always encrypts; the switch exists for API clients and tests).
  e2ee: {
    required: env.E2EE_REQUIRED === 'true',
    maxDevicesPerUser: int('MAX_DEVICES_PER_USER', 10),
  },
  sockets: {
    // Open tabs/devices per account; more is almost certainly abuse.
    maxPerUser: int('MAX_SOCKETS_PER_USER', 20),
  },
  uploads: {
    dir: path.resolve(rootDir, env.UPLOAD_DIR || 'uploads'),
    avatarMaxBytes: 2 * 1024 * 1024,
    // Per-kind size limits for chat attachments (MB).
    maxBytes: {
      image: int('MAX_IMAGE_MB', 16) * 1024 * 1024,
      video: int('MAX_VIDEO_MB', 100) * 1024 * 1024,
      audio: int('MAX_AUDIO_MB', 32) * 1024 * 1024,
      voice: int('MAX_AUDIO_MB', 32) * 1024 * 1024,
      file: int('MAX_FILE_MB', 100) * 1024 * 1024,
      sticker: 512 * 1024,
    },
    thumbnailMaxBytes: 512 * 1024,
    // Total a single user may upload in 24 hours (stops one account filling the disk).
    dailyQuotaBytes: int('MAX_UPLOAD_MB_PER_DAY', 2048) * 1024 * 1024,
    maxAttachmentsPerMessage: 10,
    // Uploaded but never sent attachments are deleted after this long.
    orphanTtlHours: 24,
  },
  // Where call recordings are stored: 'local' (UPLOAD_DIR on this server) or 's3'.
  storage: {
    driver: storageDriver,
    s3: {
      bucket: env.S3_BUCKET || '',
      region: env.S3_REGION || env.AWS_REGION || 'ap-south-1',
      // Optional folder inside the bucket, e.g. "prod/" (always ends with a slash when set).
      prefix: (env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '').replace(/(.)$/, '$1/'),
      // S3-compatible services (MinIO, Cloudflare R2): their URL, and usually path-style addressing.
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    },
  },
  recordings: {
    maxBytes: int('MAX_RECORDING_MB', 1024) * 1024 * 1024,
    // The browser uploads a chunk every few seconds; one chunk is never this big.
    maxChunkBytes: 8 * 1024 * 1024,
    maxDurationMs: 4 * 60 * 60 * 1000,
    // After a call ends, the recorder's last chunks may still be on their way.
    finalizeGraceMs: int('RECORDING_FINALIZE_SECONDS', 20) * 1000,
  },
});
