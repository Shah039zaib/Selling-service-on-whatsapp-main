import { Router } from 'express';
import { liveness, readiness } from '../controllers/health.controller.js';

const router = Router();

/**
 * Health check endpoints for container orchestration and monitoring
 *
 * GET /health/live - Liveness probe (returns 200 if process is alive)
 * GET /health/ready - Readiness probe (returns 200 if system is ready to serve traffic)
 *
 * These endpoints do NOT require authentication to support automated health checking
 */

router.get('/live', liveness);
router.get('/ready', readiness);

export default router;
