import { Request, Response, NextFunction } from 'express';
import { doubleCsrf } from 'csrf-csrf';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const {
  generateCsrfToken,
  doubleCsrfProtection,
} = doubleCsrf({
  getSecret: () => env.JWT_SECRET,
  cookieName: '__Host-csrf',
  cookieOptions: {
    sameSite: 'strict',
    path: '/',
    secure: env.NODE_ENV === 'production',
    httpOnly: true,
  },
  size: 64,
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
  getSessionIdentifier: (req: Request) => {
    // Use a combination of user session or IP as identifier
    return req.ip || 'anonymous';
  },
});

export function csrfProtection(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  doubleCsrfProtection(req, res, (err) => {
    if (err) {
      logger.warn({ error: err, ip: req.ip }, 'CSRF validation failed');
      res.status(403).json({
        success: false,
        error: 'Invalid CSRF token',
      });
      return;
    }
    next();
  });
}

export function getCsrfToken(req: Request, res: Response): void {
  const token = generateCsrfToken(req, res);
  res.json({
    success: true,
    data: { csrfToken: token },
  });
}
