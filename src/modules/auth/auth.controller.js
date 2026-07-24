import Joi from 'joi';
import * as userService from '../user/user.service.js';
import { success } from '../../shared/utils/response.js';
import { env } from '../../config/env.js';

const loginSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email({ tlds: { allow: false } }).required(),
    password: Joi.string().required(),
  }),
});

export const loginValidation = loginSchema;

export async function login(req, res, next) {
  try {
    const result = await userService.login(req.body.email, req.body.password, {
      ipAddress: req.ip,
      deviceInfo: { userAgent: req.get('user-agent') },
    });

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: env.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

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

export async function logout(req, res, next) {
  try {
    await userService.logout(req.cookies?.refreshToken);
    res.clearCookie('refreshToken');
    return success(res, { message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;
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
