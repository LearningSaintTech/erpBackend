import Redis from 'ioredis';
import { env } from '../../config/env.js';

let redis;

export function getRedis() {
  if (!redis && env.redisUrl) {
    redis = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      keyPrefix: env.redisKeyPrefix || '',
    });
    redis.on('error', (err) => {
      console.warn('[REDIS]', err.message);
    });
    redis.connect().catch(() => {
      console.warn('[REDIS] Connection failed — running without cache');
    });
  }
  return redis;
}

export function isRedisReady() {
  return Boolean(redis && redis.status === 'ready');
}

export async function cacheGet(key) {
  const client = getRedis();
  if (!client) return null;
  try {
    const val = await client.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value, ttlSeconds = 300) {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch { /* ignore */ }
}
