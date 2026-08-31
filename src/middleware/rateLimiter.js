import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // Bypass for automated end-to-end runs (smoke test / test env) so the high
  // request volume of a full-pipeline pass isn't throttled. Production unaffected.
  skip: () => process.env.DISABLE_RATE_LIMIT === 'true' || process.env.NODE_ENV === 'test',
  message: { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' } },
});
