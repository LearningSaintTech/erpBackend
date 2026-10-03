import crypto from 'crypto';
import { User } from '../user/user.model.js';
import { Organization } from '../organization/organization.model.js';
import { issueAuthSession } from '../user/user.service.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../shared/errors/AppError.js';
import { env } from '../../config/env.js';
import { OTP_PURPOSE } from './otp.constants.js';
import { isReviewPhone, normalizeMobile } from './appleReviewOtp.util.js';
import { sendOtp, verifyOtp } from './otpSession.service.js';

const PHONE_RE = /^[6-9]\d{9}$/;

function blockedPhones() {
  return String(process.env.OTP_BLOCKED_PHONES || '')
    .split(',')
    .map((p) => normalizeMobile(p))
    .filter(Boolean);
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] || 'User';
  const lastName = parts.slice(1).join(' ') || 'User';
  return { firstName, lastName };
}

export async function findUserByPhone(phoneNumber) {
  const mobile = normalizeMobile(phoneNumber);
  if (!mobile) return null;
  const raw = String(phoneNumber || '').trim();
  let user = await User.findOne({ phone: raw, isDeleted: false });
  if (user) return user;
  if (mobile !== raw) {
    user = await User.findOne({ phone: mobile, isDeleted: false });
    if (user) return user;
  }
  return User.findOne({ phone: mobile, isDeleted: false });
}

async function defaultOrganization() {
  const org = await Organization.findOne({ status: 'ACTIVE', isDeleted: { $ne: true } }).sort({ createdAt: 1 });
  if (org) return org;
  return Organization.findOne({ isDeleted: { $ne: true } }).sort({ createdAt: 1 });
}

function assertSendableUser(user) {
  if (!user) throw new NotFoundError('Phone number not Registered.Please register first');
  if (user.status === 'LOCKED' && user.lockedUntil && user.lockedUntil > new Date()) {
    throw new UnauthorizedError('Account locked. Try again later.');
  }
  if (user.status === 'INACTIVE' && user.isNumberVerified) {
    throw new UnauthorizedError('Account inactive');
  }
}

async function ensureReviewUser(phoneNumber, countryCode) {
  const mobile = normalizeMobile(phoneNumber);
  let user = await findUserByPhone(mobile);
  if (user) return user;
  const org = await defaultOrganization();
  const passwordHash = await User.hashPassword(crypto.randomBytes(32).toString('hex'));
  user = await User.create({
    organizationId: org?._id,
    email: `otp.${mobile}@otp.local`,
    passwordHash,
    firstName: 'App',
    lastName: 'Review',
    phone: mobile,
    countryCode: countryCode || '+91',
    isNumberVerified: false,
    status: 'INACTIVE',
  });
  return user;
}

export async function registerOtp({ name, countryCode = '+91', phoneNumber }) {
  if (!env.otpRegisterEnabled) {
    throw new ForbiddenError('Phone registration is disabled. Please contact an administrator.');
  }
  const mobile = normalizeMobile(phoneNumber);
  if (!PHONE_RE.test(mobile)) throw new BadRequestError('Invalid phone number format');
  if (blockedPhones().includes(mobile)) {
    throw new ConflictError('This phone number cannot be registered');
  }

  let user = await User.findOne({ phone: mobile });
  if (user && user.isDeleted) {
    user.isDeleted = false;
    user.deletedAt = undefined;
    user.isNumberVerified = false;
    user.status = 'INACTIVE';
  }
  if (user && !user.isDeleted && (user.isNumberVerified || user.status === 'ACTIVE')) {
    throw new ConflictError('User already registered.Please login');
  }

  const { firstName, lastName } = splitName(name);
  if (user) {
    user.firstName = firstName;
    user.lastName = lastName;
    user.countryCode = countryCode || user.countryCode || '+91';
    user.phone = mobile;
    await user.save();
  } else {
    const org = await defaultOrganization();
    if (!org) throw new BadRequestError('No organization is configured for registration');
    const passwordHash = await User.hashPassword(crypto.randomBytes(32).toString('hex'));
    try {
      user = await User.create({
        organizationId: org._id,
        email: `otp.${mobile}@otp.local`,
        passwordHash,
        firstName,
        lastName,
        phone: mobile,
        countryCode: countryCode || '+91',
        isNumberVerified: false,
        status: 'INACTIVE',
      });
    } catch (err) {
      if (err?.code === 11000) {
        throw new ConflictError('User already registered.Please login');
      }
      throw err;
    }
  }

  await sendOtp({ subjectId: user._id, purpose: OTP_PURPOSE, phoneNumber: mobile });
  return { userId: user._id, message: 'OTP sent successfully' };
}

export async function loginOtp({ countryCode = '+91', phoneNumber }) {
  const mobile = normalizeMobile(phoneNumber);
  if (!PHONE_RE.test(mobile) && !isReviewPhone(mobile)) {
    throw new BadRequestError('Invalid phone number format');
  }

  let user = await findUserByPhone(mobile);
  if (!user && isReviewPhone(mobile)) {
    user = await ensureReviewUser(mobile, countryCode);
  }
  assertSendableUser(user);
  await sendOtp({ subjectId: user._id, purpose: OTP_PURPOSE, phoneNumber: user.phone || mobile });
  return { userId: user._id, message: 'OTP send successfully' };
}

export async function resendOtp({ userId }) {
  const user = await User.findById(userId);
  if (!user || user.isDeleted) throw new NotFoundError('User not found');
  assertSendableUser(user);
  if (!user.phone) throw new BadRequestError('User has no phone number');
  await sendOtp({ subjectId: user._id, purpose: OTP_PURPOSE, phoneNumber: user.phone });
  return { userId: user._id, message: 'OTP sent successfully' };
}

export async function verifyNumberOtp({ userId, otp }, meta = {}) {
  const user = await User.findById(userId);
  if (!user || user.isDeleted) throw new NotFoundError('User not found');
  if (user.status === 'LOCKED' && user.lockedUntil && user.lockedUntil > new Date()) {
    throw new UnauthorizedError('Account locked. Try again later.');
  }
  if (user.status === 'INACTIVE' && user.isNumberVerified) {
    throw new UnauthorizedError('Account inactive');
  }

  await verifyOtp({ subjectId: user._id, purpose: OTP_PURPOSE, otp, phoneNumber: user.phone });

  user.isNumberVerified = true;
  user.status = 'ACTIVE';
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save();

  return issueAuthSession(user, meta);
}
