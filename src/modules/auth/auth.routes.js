import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import * as ctrl from './auth.controller.js';
import { loginRateLimiter, otpRateLimiter, verifyOtpRateLimiter } from './otpRateLimit.middleware.js';

const router = Router();

router.post('/login', validate(ctrl.loginValidation), ctrl.login);
router.post('/refresh', ctrl.refresh);
router.post('/newAccessToken', ctrl.refresh);
router.post('/logout', ctrl.logout);

router.post('/otp/register', validate(ctrl.otpRegisterValidation), otpRateLimiter, ctrl.otpRegister);
router.post('/otp/login', validate(ctrl.otpLoginValidation), loginRateLimiter, ctrl.otpLogin);
router.post('/otp/resend', validate(ctrl.resendOtpValidation), otpRateLimiter, ctrl.otpResend);
router.post('/otp/verify', validate(ctrl.verifyOtpValidation), verifyOtpRateLimiter, ctrl.otpVerify);

router.post('/register', validate(ctrl.otpRegisterValidation), otpRateLimiter, ctrl.otpRegister);
router.post('/resend-otp', validate(ctrl.resendOtpValidation), otpRateLimiter, ctrl.otpResend);
router.post('/verify-otp', validate(ctrl.verifyOtpValidation), verifyOtpRateLimiter, ctrl.otpVerify);

export default router;
