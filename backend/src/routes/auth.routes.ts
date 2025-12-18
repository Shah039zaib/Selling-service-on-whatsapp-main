import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import {
  loginLimiter,
  emailLoginLimiter,
  registerLimiter,
  passwordChangeLimiter,
} from '../middleware/rate-limit.middleware.js';
import { csrfProtection, getCsrfToken } from '../middleware/csrf.middleware.js';
import {
  login,
  loginSchema,
  register,
  registerSchema,
  getProfile,
  changePassword,
  changePasswordSchema,
  logout,
} from '../controllers/auth.controller.js';

const router = Router();

router.get('/csrf-token', getCsrfToken);
router.post('/login', loginLimiter, emailLoginLimiter, csrfProtection, validate(loginSchema), login);
router.post('/register', registerLimiter, csrfProtection, validate(registerSchema), register);
router.get('/profile', authenticate, getProfile);
router.post('/change-password', authenticate, passwordChangeLimiter, csrfProtection, validate(changePasswordSchema), changePassword);
router.post('/logout', authenticate, csrfProtection, logout);

export default router;
