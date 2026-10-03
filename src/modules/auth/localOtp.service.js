import crypto from 'crypto';
import { env } from '../../config/env.js';
import { BadRequestError } from '../../shared/errors/AppError.js';
import { OTP_LENGTH, OTP_TTL } from './otp.constants.js';
import { redisDel, redisGet, redisSet } from './otpRedis.util.js';

function localKey(purpose, userId) {
  return `otp:${purpose}:${userId}`;
}

function timingSafeEqualStr(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export async function createLocalOtp({ userId, purpose }) {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = 10 ** OTP_LENGTH;
  const otp = String(crypto.randomInt(min, max));
  await redisSet(localKey(purpose, userId), otp, OTP_TTL);
  if (env.nodeEnv !== 'production') {
    console.info(`[OTP] local code for ${purpose}:${userId} is ${otp} (dev only, not returned by API)`);
  }
  return otp;
}

export async function verifyLocalOtp({ userId, purpose, otp }) {
  const stored = await redisGet(localKey(purpose, userId));
  if (!stored) throw new BadRequestError('OTP Expired');
  if (!timingSafeEqualStr(stored, otp)) {
    throw new BadRequestError('Invalid OTP.');
  }
  await redisDel(localKey(purpose, userId));
  return true;
}
