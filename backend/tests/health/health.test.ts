/**
 * Health Endpoint Tests
 *
 * Tests the health check endpoints used by container orchestration
 * and load balancers to determine service status.
 *
 * Endpoints:
 * - GET /health/live - Liveness probe (process alive check) - FAST
 * - GET /health/ready - Readiness probe (dependency health check) - SLOW
 *
 * Note: Readiness check may return 503 in test environment if services
 * (database, AI providers, WhatsApp) are not initialized. Both 200 and
 * 503 are acceptable responses per requirements.
 *
 * Test Categories:
 * - FAST: Smoke tests, basic HTTP response validation (< 1 second)
 * - SLOW: Readiness checks that may involve service initialization (< 5 seconds)
 *
 * CI Configuration:
 * - Default (npm test): Runs all tests
 * - Fast mode (npm run test:fast): Excludes health/ directory
 * - CI mode (npm run test:ci): Runs all tests with strict exit codes
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

describe('Health Endpoints', () => {
  // FAST: Liveness checks are quick and don't require service initialization
  describe('GET /health/live', () => {
    it('should return 200 status', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/live');

      expect(response.status).toBe(200);
    });

    it('should return JSON response', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/live');

      expect(response.headers['content-type']).toMatch(/json/);
      expect(response.body).toBeDefined();
    });

    it('should return status field', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/live');

      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('alive');
    });

    it('should return timestamp field', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/live');

      expect(response.body).toHaveProperty('timestamp');
      expect(typeof response.body.timestamp).toBe('string');
      // Verify it's a valid ISO timestamp
      expect(() => new Date(response.body.timestamp)).not.toThrow();
    });

    it('should respond quickly (< 1 second)', async () => {
      const app = createTestApp();

      const startTime = Date.now();
      await request(app).get('/health/live');
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(1000);
    });
  });

  // SLOW: Readiness checks may involve database pings and service health validation
  describe('GET /health/ready', () => {
    it('should return either 200 or 503 status', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/ready');

      // Both 200 (ready) and 503 (not ready) are acceptable per requirements
      // In test environment without initialized services, 503 is expected
      expect([200, 503]).toContain(response.status);
    });

    it('should return JSON response', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/ready');

      expect(response.headers['content-type']).toMatch(/json/);
      expect(response.body).toBeDefined();
    });

    it('should return status field', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/ready');

      expect(response.body).toHaveProperty('status');
      expect(['ready', 'not_ready']).toContain(response.body.status);
    });

    it('should return reason when not ready (503)', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/ready');

      if (response.status === 503) {
        expect(response.body).toHaveProperty('reason');
        expect(typeof response.body.reason).toBe('string');
      }
    });

    it('should respond quickly (< 5 seconds)', async () => {
      const app = createTestApp();

      const startTime = Date.now();
      await request(app).get('/health/ready');
      const duration = Date.now() - startTime;

      // Readiness check may involve database ping, allow more time
      expect(duration).toBeLessThan(5000);
    });

    it('should not require authentication', async () => {
      const app = createTestApp();

      // Request without auth headers should still work
      const response = await request(app).get('/health/ready');

      // Should not return 401 or 403
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });
  });

  describe('Health Endpoint Security', () => {
    it('should not expose sensitive information in liveness response', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/live');

      // Should only contain status and timestamp
      const allowedFields = ['status', 'timestamp'];
      const responseFields = Object.keys(response.body);

      expect(responseFields.every(field => allowedFields.includes(field))).toBe(true);
    });

    it('should not expose detailed errors in readiness response', async () => {
      const app = createTestApp();

      const response = await request(app).get('/health/ready');

      // Should not contain error stack traces or detailed error messages
      expect(response.body).not.toHaveProperty('stack');
      expect(response.body).not.toHaveProperty('error');

      // Reason should be generic
      if (response.body.reason) {
        expect(response.body.reason).toMatch(/^[a-z_]+$/); // snake_case identifier only
      }
    });
  });

  describe('Health Endpoint Reliability', () => {
    it('should handle concurrent requests to /health/live', async () => {
      const app = createTestApp();

      const requests = Array(10).fill(null).map(() =>
        request(app).get('/health/live')
      );

      const responses = await Promise.all(requests);

      // All should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });

    it('should handle concurrent requests to /health/ready', async () => {
      const app = createTestApp();

      const requests = Array(10).fill(null).map(() =>
        request(app).get('/health/ready')
      );

      const responses = await Promise.all(requests);

      // All should return valid status
      responses.forEach(response => {
        expect([200, 503]).toContain(response.status);
      });
    });
  });
});
