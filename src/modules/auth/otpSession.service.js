import { env } from '../../config/env.js';
import { BadRequestError, TooManyRequestsError } from '../../shared/errors/AppError.js';
import {
  LOCAL_SESSION_SENTINEL,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_PURPOSE,
  OTP_RESEND_COOLDOWN_SEC,
  OTP_TTL,
  REVIEW_SESSION_SENTINEL,
} from './otp.constants.js';
import { expectedBypassOtp, isBypassOtpPhone } from './appleReviewOtp.util.js';
import { providerSendOtp, providerVerifyOtp } from './twofactorApi.service.js';
import { createLocalOtp, verifyLocalOtp } from './localOtp.service.js';
import { redisDel, redisGet, redisIncr, redisSet } from './otpRedis.util.js';

function sessionKey(purpose, subjectId) {
  return `otp2factor:session:${purpose}:${subjectId}`;
}

function failKey(purpose, subjectId) {
  return `otp2factor:fails:${purpose}:${subjectId}`;
}

function cooldownKey(purpose, subjectId) {
  return `otp2factor:cooldown:${purpose}:${subjectId}`;
}

function hasTwoFactor() {
  return Boolean(env.twofactorApiKey);
}

async function assertCooldown(purpose, subjectId) {
  const existing = await redisGet(cooldownKey(purpose, subjectId));
  if (existing) {
    throw new TooManyRequestsError('Please wait before requesting another OTP.');
  }
}

export async function sendOtp({
  subjectId,
  purpose = OTP_PURPOSE,
  phoneNumber,
}) {
  if (!subjectId || !phoneNumber) {
    throw new BadRequestError('subjectId and phoneNumber are required');
  }
  const id = String(subjectId);
  await assertCooldown(purpose, id);

  const key = sessionKey(purpose, id);
  let sessionId;

  if (isBypassOtpPhone(phoneNumber)) {
    sessionId = REVIEW_SESSION_SENTINEL;
  } else if (hasTwoFactor()) {
    sessionId = (await providerSendOtp(phoneNumber)).sessionId;
  } else if (env.nodeEnv === 'production') {
    throw new BadRequestError('SMS OTP provider is not configured');
  } else {
    await createLocalOtp({ userId: id, purpose });
    sessionId = LOCAL_SESSION_SENTINEL;
  }

  await redisSet(key, sessionId, OTP_TTL);
  await redisDel(failKey(purpose, id));
  await redisSet(cooldownKey(purpose, id), '1', OTP_RESEND_COOLDOWN_SEC);
}

export async function verifyOtp({
  subjectId,
  purpose = OTP_PURPOSE,
  otp,
  phoneNumber,
}) {
  if (!subjectId || !otp) {
    throw new BadRequestError('subjectId and otp are required');
  }
  const id = String(subjectId);
  const key = sessionKey(purpose, id);
  const sessionId = await redisGet(key);
  if (!sessionId) throw new BadRequestError('OTP Expired');

  try {
    if (sessionId === REVIEW_SESSION_SENTINEL) {
      const expected = expectedBypassOtp(phoneNumber);
      if (!expected || String(otp) !== expected) throw new BadRequestError('Invalid OTP.');
    } else if (sessionId === LOCAL_SESSION_SENTINEL) {
      await verifyLocalOtp({ userId: id, purpose, otp });
    } else {
      await providerVerifyOtp({ sessionId, otp });
    }
  } catch (err) {
    if (err?.statusCode === 400) {
      const attempts = await redisIncr(failKey(purpose, id), OTP_TTL);
      if (attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        await redisDel(key);
        await redisDel(failKey(purpose, id));
        throw new BadRequestError('Too many invalid attempts. Please request a new OTP.');
      }
    }
    throw err;
  }

  await redisDel(key);
  await redisDel(failKey(purpose, id));
  return true;
}
