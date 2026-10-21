import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { closePool, pool } from './db/pool.js';
import { otpRepository } from './repositories/otpRepository.js';
import { sessionRepository } from './repositories/sessionRepository.js';
import { attachmentService } from './services/attachmentService.js';
import { callService } from './services/callService.js';
import { recordingService } from './services/recordingService.js';
import { settlePresence } from './sockets/handlers/presenceHandlers.js';
import { createSocketServer } from './sockets/index.js';
import { logger } from './utils/logger.js';

async function main() {
  // Fail fast if the database is unreachable or not migrated.
  try {
    await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
    // No call can survive a restart; this also fails if the latest migrations are missing.
    await callService.closeStale();
    // Recordings cut off by the restart are saved with the chunks that arrived.
    await recordingService.recoverInterrupted();
  } catch (error) {
    logger.error('Database is not ready. Did you run "npm run migrate"?', { error });
    process.exit(1);
  }

  warnAboutRiskySettings();

  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);

  // Housekeeping: purge expired sessions and codes, and uploads that were never sent.
  const cleanup = setInterval(() => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    Promise.all([
      sessionRepository.deleteExpired(dayAgo),
      otpRepository.deleteExpired(dayAgo),
      attachmentService.deleteOrphans(),
    ]).catch((error) => {
      logger.error('Cleanup failed', { error });
    });
  }, 60 * 60 * 1000);
  cleanup.unref();

  server.listen(config.port, () => {
    logger.info(`API listening on http://localhost:${config.port} (${config.env})`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    io.close();
    server.close();
    await settlePresence(); // last-seen writes from the disconnects above
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Production settings that are easy to forget and silently weaken security. */
function warnAboutRiskySettings() {
  if (!config.isProduction) return;
  const warnings = [];
  if (!config.mail.host) warnings.push('SMTP_HOST is empty: verification and password-reset codes cannot be emailed, so nobody can sign up.');
  if (config.hosted && !config.trustProxy) warnings.push('TRUST_PROXY is 0 behind a hosting proxy: rate limits would treat all users as one IP. Set TRUST_PROXY=1.');
  if (config.clientOrigins.some((origin) => /localhost|127\.0\.0\.1/.test(origin))) warnings.push('CLIENT_ORIGIN still allows localhost.');
  if (config.db.user === 'root') warnings.push('The app connects to the database as root. Prefer a user with only SELECT/INSERT/UPDATE/DELETE (see README).');
  if (!config.push.enabled) warnings.push('VAPID keys are not set: no notifications while TEMU is closed.');
  for (const warning of warnings) logger.warn(`Configuration: ${warning}`);
}

main();
