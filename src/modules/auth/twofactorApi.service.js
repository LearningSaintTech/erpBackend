import { env } from '../../config/env.js';
import { BadGatewayError, BadRequestError, ServiceUnavailableError } from '../../shared/errors/AppError.js';
import { normalizeMobile } from './appleReviewOtp.util.js';

const TIMEOUT_MS = 12000;

function config() {
  const apiKey = env.twofactorApiKey;
  if (!apiKey) {
    throw new ServiceUnavailableError('SMS OTP provider is not configured');
  }
  return {
    apiKey,
    api: `${env.twofactorBaseUrl}/API/V1`,
    template: env.twofactorOtpTemplateName || 'OTPtemplate',
  };
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new BadGatewayError(`Failed to reach OTP provider: ${err.message || 'Unknown error'}`);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return data;
}

function providerDetails(data) {
  return data?.Details || data?.Message || 'Unknown error';
}

export async function providerSendOtp(mobile) {
  const { apiKey, api, template } = config();
  const digits = normalizeMobile(mobile);
  if (!digits) throw new BadRequestError('Invalid mobile number');

  const data = await getJson(`${api}/${apiKey}/SMS/${digits}/AUTOGEN/${encodeURIComponent(template)}`);
  if (data?.Status === 'Success' && data?.Details) {
    return { sessionId: String(data.Details) };
  }
  throw new BadRequestError(`Failed to send OTP: ${providerDetails(data)}`);
}

export async function providerVerifyOtp({ sessionId, otp }) {
  const { apiKey, api } = config();
  const data = await getJson(`${api}/${apiKey}/SMS/VERIFY/${sessionId}/${String(otp)}`);
  if (data?.Status === 'Success') return true;

  const details = String(providerDetails(data));
  const expired = /expired|timeout/i.test(details);
  throw new BadRequestError(expired ? 'OTP expired. Please request a new OTP.' : 'Invalid OTP.');
}
