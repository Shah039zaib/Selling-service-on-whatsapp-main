import { Response } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { generateToken } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { AuthenticatedRequest, APIResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

// Account lockout configuration
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 30;

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

export const login = asyncHandler(async (
  req: AuthenticatedRequest,
  res: Response<APIResponse>
): Promise<void> => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user) {
    // Don't reveal that the user doesn't exist
    res.status(401).json({
      success: false,
      error: 'Invalid email or password',
    });
    return;
  }

  // Check if account is locked
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const remainingMinutes = Math.ceil(
      (user.lockedUntil.getTime() - Date.now()) / (1000 * 60)
    );

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'login_attempt_while_locked',
        entity: 'user',
        entityId: user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        newData: {
          remainingMinutes,
          lockedUntil: user.lockedUntil,
        },
      },
    });

    logger.warn(
      { userId: user.id, remainingMinutes },
      'Login attempt on locked account'
    );

    res.status(403).json({
      success: false,
      error: `Account is temporarily locked due to multiple failed login attempts. Please try again in ${remainingMinutes} minute(s)`,
    });
    return;
  }

  // Auto-unlock account if lockout period has expired
  if (user.lockedUntil && user.lockedUntil <= new Date()) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        lockedUntil: null,
        failedLoginAttempts: 0,
      },
    });
  }

  if (!user.isActive) {
    res.status(403).json({
      success: false,
      error: 'Account is deactivated',
    });
    return;
  }

  const isValidPassword = await argon2.verify(user.passwordHash, password);

  if (!isValidPassword) {
    // Increment failed login attempts
    const newFailedAttempts = user.failedLoginAttempts + 1;
    const shouldLock = newFailedAttempts >= MAX_FAILED_ATTEMPTS;

    const updateData: any = {
      failedLoginAttempts: newFailedAttempts,
    };

    if (shouldLock) {
      const lockoutUntil = new Date(
        Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000
      );
      updateData.lockedUntil = lockoutUntil;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: shouldLock ? 'account_locked' : 'login_failed',
        entity: 'user',
        entityId: user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        newData: {
          failedAttempts: newFailedAttempts,
          locked: shouldLock,
          lockedUntil: shouldLock ? updateData.lockedUntil : null,
        },
      },
    });

    logger.warn(
      { userId: user.id, failedAttempts: newFailedAttempts, locked: shouldLock },
      'Failed login attempt'
    );

    if (shouldLock) {
      res.status(403).json({
        success: false,
        error: `Account locked due to ${MAX_FAILED_ATTEMPTS} failed login attempts. Please try again in ${LOCKOUT_DURATION_MINUTES} minutes`,
      });
    } else {
      const remainingAttempts = MAX_FAILED_ATTEMPTS - newFailedAttempts;
      res.status(401).json({
        success: false,
        error: `Invalid email or password. ${remainingAttempts} attempt(s) remaining before account lockout`,
      });
    }
    return;
  }

  // Successful login - reset failed attempts and lockout
  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  const token = generateToken({
    id: user.id,
    email: user.email,
    role: user.role,
  });

  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'login_success',
      entity: 'user',
      entityId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    },
  });

  logger.info({ userId: user.id }, 'User logged in successfully');

  res.json({
    success: true,
    data: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    },
  });
});

export const register = asyncHandler(async (
  req: AuthenticatedRequest,
  res: Response<APIResponse>
): Promise<void> => {
  const { email, password, name } = req.body as z.infer<typeof registerSchema>;

  const existingUser = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (existingUser) {
    res.status(409).json({
      success: false,
      error: 'Email already registered',
    });
    return;
  }

  const passwordHash = await argon2.hash(password);

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash,
      name,
      role: 'ADMIN',
    },
  });

  const token = generateToken({
    id: user.id,
    email: user.email,
    role: user.role,
  });

  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'register',
      entity: 'user',
      entityId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    },
  });

  logger.info({ userId: user.id }, 'New user registered');

  res.status(201).json({
    success: true,
    data: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    },
  });
});

export const getProfile = asyncHandler(async (
  req: AuthenticatedRequest,
  res: Response<APIResponse>
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Not authenticated',
    });
    return;
  }

  res.json({
    success: true,
    data: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
      lastLoginAt: req.user.lastLoginAt,
      createdAt: req.user.createdAt,
    },
  });
});

export const changePassword = asyncHandler(async (
  req: AuthenticatedRequest,
  res: Response<APIResponse>
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Not authenticated',
    });
    return;
  }

  const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
  });

  if (!user) {
    res.status(404).json({
      success: false,
      error: 'User not found',
    });
    return;
  }

  const isValidPassword = await argon2.verify(user.passwordHash, currentPassword);

  if (!isValidPassword) {
    res.status(401).json({
      success: false,
      error: 'Current password is incorrect',
    });
    return;
  }

  const newPasswordHash = await argon2.hash(newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newPasswordHash },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'change_password',
      entity: 'user',
      entityId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    },
  });

  logger.info({ userId: user.id }, 'Password changed');

  res.json({
    success: true,
    message: 'Password changed successfully',
  });
});

export const logout = asyncHandler(async (
  req: AuthenticatedRequest,
  res: Response<APIResponse>
): Promise<void> => {
  if (req.user) {
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'logout',
        entity: 'user',
        entityId: req.user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    });
  }

  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });

  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});
