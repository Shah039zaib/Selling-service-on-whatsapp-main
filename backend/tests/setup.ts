/**
 * Test setup - runs before all tests
 * Sets minimal environment variables required for tests
 */

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Required database URL (can be a dummy value for smoke tests)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db';

// JWT secret (minimum 32 chars)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-minimum-32-characters-long';

// WhatsApp session secret (minimum 16 chars)
process.env.WHATSAPP_SESSION_SECRET = process.env.WHATSAPP_SESSION_SECRET || 'test-whatsapp-secret-16-chars';

// Cloudinary config (can be dummy values for smoke tests)
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'test-cloud';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'test-api-key';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'test-api-secret';

// Admin credentials (minimum requirements)
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'test@example.com';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-password-12-chars';

// Optional: CORS origin
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

// Optional: Log level (reduce noise in tests)
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
