import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { env } from '../config/env.js';
import { APIResponse } from '../types/index.js';

// Helper to generate IP-based key with IPv6 subnet support
const ipKeyGenerator = (req: Request): string => {
  if (!req.ip) {
    return req.socket.remoteAddress || 'unknown';
  }
  // Remove port if present
  return req.ip.replace(/:\d+[^:]*$/, '');
};

// Helper to generate email-based key for login attempts
const emailKeyGenerator = (req: Request): string => {
  const email = req.body?.email?.toLowerCase();
  return email ? `email:${email}` : ipKeyGenerator(req);
};

export const apiLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests, please try again later',
  } as APIResponse,
  keyGenerator: ipKeyGenerator,
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

// Login rate limiter - combines IP and email-based limiting
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5, // 5 attempts per window
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many login attempts from this IP. Please try again after 15 minutes',
  } as APIResponse,
  keyGenerator: ipKeyGenerator,
  skipSuccessfulRequests: true, // Don't count successful logins
  skipFailedRequests: false,
});

// Email-specific login limiter to prevent credential stuffing
export const emailLoginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 minutes
  limit: 10, // 10 attempts per email per window
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many login attempts for this account. Please try again after 30 minutes or reset your password',
  } as APIResponse,
  keyGenerator: emailKeyGenerator,
  skipSuccessfulRequests: true,
  skipFailedRequests: false,
});

// Registration rate limiter
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 3, // 3 registrations per IP per hour
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many registration attempts from this IP. Please try again after 1 hour',
  } as APIResponse,
  keyGenerator: ipKeyGenerator,
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

// Password change rate limiter
export const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5, // 5 password changes per hour
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many password change attempts. Please try again after 1 hour',
  } as APIResponse,
  keyGenerator: (req: Request): string => {
    // Use user ID if authenticated, otherwise IP
    const userId = (req as any).user?.id;
    return userId ? `user:${userId}` : ipKeyGenerator(req);
  },
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

// Legacy auth limiter for backward compatibility
export const authLimiter = loginLimiter;

export const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Rate limit exceeded for this operation',
  } as APIResponse,
  keyGenerator: ipKeyGenerator,
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many upload requests',
  } as APIResponse,
  keyGenerator: ipKeyGenerator,
});
