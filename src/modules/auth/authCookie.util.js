import { env } from '../../config/env.js';
import { parseDurationMs } from '../../shared/utils/duration.js';

export function refreshTtlMs() {
  return parseDurationMs(env.jwtRefreshExpiry, 7 * 24 * 60 * 60 * 1000);
}

export function refreshTtlSec() {
  return Math.max(60, Math.floor(refreshTtlMs() / 1000));
}

export function refreshTokenCookieOptions() {
  const isProd = env.nodeEnv === 'production';
  const sameSite = isProd ? 'none' : (env.cookieSameSite || 'lax');
  return {
    httpOnly: true,
    secure: isProd || sameSite === 'none',
    sameSite,
    path: '/',
    ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
    maxAge: refreshTtlMs(),
  };
}

export function clearRefreshTokenCookie(res) {
  const options = refreshTokenCookieOptions();
  res.clearCookie('refreshToken', {
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
    path: options.path,
    ...(options.domain ? { domain: options.domain } : {}),
  });
}
