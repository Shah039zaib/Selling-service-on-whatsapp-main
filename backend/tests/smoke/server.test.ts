/**
 * Smoke tests - Ensure server can boot without crashing
 *
 * These tests verify that:
 * 1. The Express app can be created and configured
 * 2. Routes are properly mounted
 * 3. Middleware stack is correctly set up
 * 4. No syntax errors or import issues prevent startup
 *
 * Test Category: FAST
 * - All smoke tests are fast (< 1 second)
 * - No external dependencies or service initialization required
 * - Suitable for rapid CI feedback loops
 *
 * Note: These tests use a minimal app setup without service initialization
 * to ensure fast, isolated testing suitable for CI environments.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

// FAST: All smoke tests complete in < 1 second
describe('Smoke Tests - Server Initialization', () => {
  it('should create Express app without crashing', () => {
    const app = createTestApp();
    expect(app).toBeDefined();
    expect(typeof app).toBe('function'); // Express app is a function
  });

  it('should have health routes mounted', async () => {
    const app = createTestApp();

    // Verify routes are accessible (any response is fine, just shouldn't 404)
    const response = await request(app).get('/health/live');

    // Should not be a 404
    expect(response.status).not.toBe(404);
  });

  it('should respond to requests without crashing', async () => {
    const app = createTestApp();

    // Make a simple request to ensure the app can handle HTTP requests
    const response = await request(app).get('/health/live');

    // Should return a valid HTTP response (not crash/timeout)
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(600);
  });

  it('should have JSON middleware configured', async () => {
    const app = createTestApp();

    const response = await request(app)
      .get('/health/live')
      .set('Accept', 'application/json');

    // Should return JSON
    expect(response.headers['content-type']).toMatch(/json/);
  });

  it('should have CORS middleware configured', async () => {
    const app = createTestApp();

    const response = await request(app)
      .get('/health/live')
      .set('Origin', 'http://localhost:3000');

    // Should have CORS headers
    expect(response.headers['access-control-allow-origin']).toBeDefined();
  });
});
