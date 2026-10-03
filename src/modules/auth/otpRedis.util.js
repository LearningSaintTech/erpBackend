import { env } from '../../config/env.js';
import { getRedis, isRedisReady } from '../../shared/services/redis.service.js';
import { ServiceUnavailableError } from '../../shared/errors/AppError.js';
import { memoryDel, memoryGet, memoryIncr, memorySet } from './otpSession.memory.js';

const TIMEOUT_MS = env.rateLimitRedisTimeoutMs || 2000;
const isProd = env.nodeEnv === 'production';

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

function unavailable() {
  return new ServiceUnavailableError('OTP service temporarily unavailable. Please try again.');
}

export async function redisSet(key, value, ttlSec) {
  try {
    if (!isRedisReady()) throw new Error('redis not ready');
    await withTimeout(getRedis().set(key, String(value), 'EX', ttlSec));
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    if (isProd) throw unavailable();
    memorySet(key, String(value), ttlSec);
  }
}

export async function redisGet(key) {
  try {
    if (!isRedisReady()) throw new Error('redis not ready');
    return await withTimeout(getRedis().get(key));
  } catch {
    if (isProd) throw unavailable();
    return memoryGet(key);
  }
}

export async function redisDel(key) {
  try {
    if (!isRedisReady()) throw new Error('redis not ready');
    await withTimeout(getRedis().del(key));
  } catch {
    if (isProd) return;
    memoryDel(key);
  }
}

export async function redisIncr(key, windowSec) {
  try {
    if (!isRedisReady()) throw new Error('redis not ready');
    const client = getRedis();
    const n = await withTimeout(client.incr(key));
    if (n === 1) await withTimeout(client.expire(key, windowSec)).catch(() => {});
    return n;
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    if (isProd) throw unavailable();
    return memoryIncr(key, windowSec);
  }
}
