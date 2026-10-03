import { env } from '../../config/env.js';
import { TooManyRequestsError, ServiceUnavailableError } from '../../shared/errors/AppError.js';
import { isRedisReady, getRedis } from '../../shared/services/redis.service.js';
import { memoryIncr } from './otpSession.memory.js';

const isProd = env.nodeEnv === 'production';
const TIMEOUT_MS = env.rateLimitRedisTimeoutMs || 2000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error('timeout');
        err.name = 'RedisTimeout';
        reject(err);
      }, ms);
    }),
  ]);
}

async function incrWindow(key, windowSec) {
  if (isRedisReady()) {
    const client = getRedis();
    const n = await withTimeout(client.incr(key));
    if (n === 1) await withTimeout(client.expire(key, windowSec)).catch(() => {});
    return n;
  }
  if (isProd) throw new ServiceUnavailableError();
  return memoryIncr(key, windowSec);
}

export async function checkRateLimit({ key, limit, windowSec }) {
  if (process.env.DISABLE_RATE_LIMIT === 'true' || env.nodeEnv === 'test') return;
  try {
    const n = await incrWindow(key, windowSec);
    if (n > limit) {
      throw new TooManyRequestsError();
    }
  } catch (err) {
    if (err instanceof TooManyRequestsError || err instanceof ServiceUnavailableError) throw err;
    if (isProd) throw new ServiceUnavailableError();
  }
}

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
}

function device(req) {
  return String(req.headers['x-device-id'] || req.body?.deviceId || '').trim().slice(0, 80);
}

function phone(req) {
  const p = String(req.body?.phoneNumber || '').replace(/\D/g, '');
  if (!p) return '';
  return `${String(req.body?.countryCode || '').replace(/\D/g, '')}:${p}`;
}

function subjectKey(prefix, req) {
  if (phone(req)) return `rate:${prefix}:phone:${phone(req)}`;
  if (device(req)) return `rate:${prefix}:device:${device(req)}`;
  return `rate:${prefix}:ip:${clientIp(req)}`;
}

function limiter(prefix, defaultLimit, keyFn = (req) => subjectKey(prefix, req), windowOverride) {
  const prodLimit = defaultLimit;
  const devLimit = Math.max(defaultLimit * 3, 100);
  return async (req, res, next) => {
    try {
      const ipCeiling = env.otpIpSoftLimit || (isProd ? 300 : 1000);
      await checkRateLimit({
        key: `rate:${prefix}:ip-ceiling:${clientIp(req)}`,
        limit: ipCeiling,
        windowSec: env.otpIpSoftWindowSec || 3600,
      });
      await checkRateLimit({
        key: keyFn(req),
        limit: isProd ? prodLimit : devLimit,
        windowSec: windowOverride || 3600,
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const otpRateLimiter = limiter('otp', env.otpRateLimit || (isProd ? 30 : 100), undefined, env.otpRateWindowSec);
export const loginRateLimiter = limiter('login', env.loginRateLimit || (isProd ? 40 : 120), undefined, env.loginRateWindowSec);
export const verifyOtpRateLimiter = limiter(
  'verify-otp',
  env.verifyOtpRateLimit || (isProd ? 40 : 120),
  (req) => (req.body?.userId ? `rate:verify-otp:user:${req.body.userId}` : subjectKey('verify-otp', req)),
  env.verifyOtpRateWindowSec,
);
