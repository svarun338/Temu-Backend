import { AppError } from '../utils/AppError.js';
import { formatIssues } from '../validation/schemas.js';

/**
 * Validate and coerce request parts with zod schemas.
 * Parsed values are exposed on req.valid.{body,params,query}; handlers must use
 * those instead of the raw request so only whitelisted, typed fields get through.
 */
export function validate(parts) {
  return (req, _res, next) => {
    req.valid = {};
    const issues = [];
    for (const [part, schema] of Object.entries(parts)) {
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) req.valid[part] = result.data;
      else issues.push(...formatIssues(result.error));
    }
    if (issues.length > 0) return next(AppError.validation(issues));
    next();
  };
}
