import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config/index.js';
import { IMAGE_MIME } from './services/profileService.js';
import { sendStoredFile } from './utils/storedFile.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { rateLimiters } from './middleware/security.js';
import { apiRouter } from './routes/index.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  app.use(
    cors({
      origin: config.clientOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Device-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use(requestLogger);

  app.use('/api', rateLimiters.api, apiRouter());

  // Profile photos and wallpapers (local disk or S3): random 128-bit file names, image bytes
  // verified on upload. Served as inert files (no sniffing, no scripts), cacheable for 30 days
  // (a new photo gets a new name).
  const IMAGE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
  const inertImage = (folder) => async (req, res, next) => {
    const match = IMAGE_NAME.exec(req.params.file);
    if (!match) return next();
    try {
      await sendStoredFile(req, res, {
        key: `${folder}/${req.params.file}`,
        headers: {
          'Content-Type': IMAGE_MIME[match[1]],
          'Cache-Control': 'public, max-age=2592000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      });
    } catch (error) {
      next(error.status === 404 ? undefined : error);
    }
  };
  app.get('/uploads/avatars/:file', inertImage('avatars'));
  app.get('/uploads/wallpapers/:file', inertImage('wallpapers'));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
