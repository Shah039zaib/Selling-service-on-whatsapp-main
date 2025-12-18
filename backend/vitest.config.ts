import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        'prisma/',
        '**/*.test.ts',
      ],
    },
    // Timeout configuration
    testTimeout: 10000,
    hookTimeout: 10000,

    // Strict test execution settings
    passWithNoTests: false, // Fail if no tests are found
    allowOnly: false, // Disallow .only() to prevent accidental test skipping
  },
});
