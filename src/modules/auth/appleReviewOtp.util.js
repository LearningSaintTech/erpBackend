import { env } from '../../config/env.js';

const STATIC_OTP_BY_PHONE = {
  '9829699382': '123456',
};

export function normalizeMobile(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function isReviewOtpEnabled() {
  return Boolean(env.appleReviewOtpEnabled);
}

export function reviewPhone() {
  return normalizeMobile(env.appleReviewPhone);
}

export function reviewOtp() {
  return String(env.appleReviewOtp || '').trim();
}

export function staticOtpFor(phone) {
  return STATIC_OTP_BY_PHONE[normalizeMobile(phone)] || '';
}

export function isStaticOtpPhone(phone) {
  return Boolean(staticOtpFor(phone));
}

export function expectedBypassOtp(phone) {
  return staticOtpFor(phone) || (isReviewPhone(phone) ? reviewOtp() : '');
}

export function isBypassOtpPhone(phone) {
  return isStaticOtpPhone(phone) || isReviewPhone(phone);
}

export function isReviewPhone(phone) {
  const expected = reviewPhone();
  return isReviewOtpEnabled() && expected && normalizeMobile(phone) === expected;
}
