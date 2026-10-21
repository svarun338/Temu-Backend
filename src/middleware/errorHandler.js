import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(req, _res, next) {
  next(AppError.notFound(`Route ${req.method} ${req.path} not found`));
}

/**
 * Last-resort error handler. Clients only ever see safe, generic messages;
 * unexpected errors are logged (without request bodies or credentials).
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let error = err;

  if (err?.type === 'entity.parse.failed') error = AppError.badRequest('Malformed JSON body');
  else if (err?.type === 'entity.too.large') error = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  else if (err?.name === 'MulterError') {
    error =
      err.code === 'LIMIT_FILE_SIZE'
        ? new AppError(413, 'FILE_TOO_LARGE', 'The file is too large')
        : AppError.badRequest('Invalid upload. Please choose the file again.');
  }

  if (!(error instanceof AppError)) {
    logger.error('Unhandled error', { method: req.method, path: req.path, userId: req.user?.id, error: err });
    error = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  }

  res.status(error.status).json({
    error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
  });
}
