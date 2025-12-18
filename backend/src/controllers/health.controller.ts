import { Request, Response } from 'express';
import { healthCheck as databaseHealthCheck } from '../config/database.js';
import { aiService } from '../services/ai.service.js';
import { whatsappService } from '../services/whatsapp.service.js';
import { logger } from '../utils/logger.js';

/**
 * Liveness check - returns 200 if process is alive
 * No external dependencies checked
 * Used by container orchestrators to restart dead containers
 */
export async function liveness(_req: Request, res: Response): Promise<void> {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Readiness check - returns 200 only if system is ready to serve traffic
 * Checks critical dependencies:
 * - Database connectivity
 * - WhatsApp service initialized
 * - AI service has at least one available provider
 *
 * Used by load balancers and orchestrators to route traffic
 */
export async function readiness(_req: Request, res: Response): Promise<void> {
  const checks = {
    database: false,
    whatsapp: false,
    ai: false,
  };

  let reason: string | undefined;

  try {
    // Check 1: Database connectivity
    const dbHealthy = await databaseHealthCheck();
    checks.database = dbHealthy;

    if (!dbHealthy) {
      reason = 'database_unreachable';
      logger.warn('Readiness check failed: database unreachable');
    }

    // Check 2: WhatsApp service initialized
    // WhatsApp service is always initialized (singleton), so just verify it exists
    if (whatsappService) {
      checks.whatsapp = true;
    } else {
      reason = reason || 'whatsapp_not_initialized';
      logger.warn('Readiness check failed: WhatsApp service not initialized');
    }

    // Check 3: AI service has at least one provider
    if (aiService.hasAvailableProviders()) {
      checks.ai = true;
    } else {
      reason = reason || 'ai_no_providers';
      logger.warn('Readiness check failed: No AI providers available');
    }

    // System is ready only if all checks pass
    if (checks.database && checks.whatsapp && checks.ai) {
      res.status(200).json({
        status: 'ready',
      });
    } else {
      res.status(503).json({
        status: 'not_ready',
        reason,
      });
    }

  } catch (error) {
    logger.error({ error }, 'Readiness check error');
    res.status(503).json({
      status: 'not_ready',
      reason: 'health_check_error',
    });
  }
}
