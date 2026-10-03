import Joi from 'joi';
import * as userService from '../user/user.service.js';
import * as otpAuth from './otpAuth.service.js';
import { success } from '../../shared/utils/response.js';
import { clearRefreshTokenCookie, refreshTokenCookieOptions } from './authCookie.util.js';
import { deviceIdFromRequest } from './authDevice.util.js';
import { env } from '../../config/env.js';
import { ForbiddenError } from '../../shared/errors/AppError.js';

const phoneBody = Joi.string().trim().pattern(/^[6-9]\d{9}$/).required()
  .messages({ 'string.pattern.base': 'Invalid phone number format' });
const countryCodeBody = Joi.string().trim().pattern(/^\+\d{1,3}$/).optional()
  .messages({ 'string.pattern.base': 'Invalid country code' });
const objectIdBody = Joi.string().hex().length(24).required()
  .messages({ 'string.length': 'Invalid user ID', 'string.hex': 'Invalid user ID' });

export const loginValidation = Joi.object({
  body: Joi.object({
    email: Joi.string().email({ tlds: { allow: false } }).required(),
    password: Joi.string().required(),
  }),
});

export const otpRegisterValidation = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(1).max(80).required(),
    countryCode: countryCodeBody,
    phoneNumber: phoneBody,
    referralCode: Joi.string().trim().optional(),
    deviceId: Joi.string().trim().max(80).optional(),
  }),
});

export const otpLoginValidation = Joi.object({
  body: Joi.object({
    countryCode: countryCodeBody,
    phoneNumber: phoneBody,
    deviceId: Joi.string().trim().max(80).optional(),
  }),
});

export const resendOtpValidation = Joi.object({
  body: Joi.object({
    userId: objectIdBody,
    deviceId: Joi.string().trim().max(80).optional(),
  }),
});

export const verifyOtpValidation = Joi.object({
  body: Joi.object({
    userId: objectIdBody,
    otp: Joi.string().trim().pattern(/^\d{4,6}$/).required()
      .messages({ 'string.pattern.base': 'OTP must be numeric' }),
    deviceId: Joi.string().trim().max(80).optional(),
  }),
});

function authMeta(req) {
  return {
    ipAddress: req.ip,
    deviceId: deviceIdFromRequest(req),
    deviceInfo: { userAgent: req.get('user-agent') },
  };
}

function setRefreshCookie(res, refreshToken) {
  res.cookie('refreshToken', refreshToken, refreshTokenCookieOptions());
}

function authPayload(result) {
  return {
    userId: result.user?._id,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: result.user,
    factories: result.factories,
    permissions: result.permissions,
  };
}

export async function login(req, res, next) {
  try {
    if (env.authPhoneOtpOnly) {
      throw new ForbiddenError('Sign in with phone OTP');
    }
    const result = await userService.login(req.body.email, req.body.password, authMeta(req));
    setRefreshCookie(res, result.refreshToken);
    return success(res, authPayload(result));
  } catch (err) {
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken || req.headers['x-refresh-token'];
    await userService.logout(token);
    clearRefreshTokenCookie(res);
    return success(res, { message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    const token = req.cookies?.refreshToken
      || req.body?.refreshToken
      || req.headers['x-refresh-token'];
    const result = await userService.refreshAccessToken(token);
    return success(res, {
      accessToken: result.accessToken,
      user: result.user,
      factories: result.factories,
      permissions: result.permissions,
    });
  } catch (err) {
    next(err);
  }
}

export async function me(req, res, next) {
  try {
    const permissions = req.user.isSuperAdmin
      ? ['*']
      : await userService.getUserPermissions(req.user._id, req.factoryId);
    const factories = req.user.isSuperAdmin
      ? await userService.getSuperAdminFactories()
      : await userService.getUserFactories(req.user._id);
    return success(res, { user: req.user, permissions, factories });
  } catch (err) {
    next(err);
  }
}

export async function otpRegister(req, res, next) {
  try {
    const data = await otpAuth.registerOtp(req.body);
    return success(res, data, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function otpLogin(req, res, next) {
  try {
    const data = await otpAuth.loginOtp(req.body);
    return success(res, data, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function otpResend(req, res, next) {
  try {
    const data = await otpAuth.resendOtp(req.body);
    return success(res, data, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function otpVerify(req, res, next) {
  try {
    const result = await otpAuth.verifyNumberOtp(req.body, authMeta(req));
    setRefreshCookie(res, result.refreshToken);
    return success(res, {
      ...authPayload(result),
      message: 'Phone Number verified successfully.',
    }, null, 201);
  } catch (err) {
    next(err);
  }
}
