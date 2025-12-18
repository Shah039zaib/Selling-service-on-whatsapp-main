/**
 * Runtime timeout and safety utilities
 * Provides Promise.race-based timeout wrappers to prevent hanging operations
 */

import { logger } from './logger.js';

// Timeout constants (in milliseconds)
export const TIMEOUT_CONSTANTS = {
  HTTP_REQUEST: 30000,        // 30 seconds for HTTP requests
  AI_PROVIDER_EXECUTION: 25000, // 25 seconds per AI provider attempt
  WHATSAPP_SEND: 10000,       // 10 seconds for WhatsApp message send
  MEDIA_DOWNLOAD: 15000,      // 15 seconds for media downloads
} as const;

export class TimeoutError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly timeoutMs: number,
    public readonly context?: Record<string, any>
  ) {
    super(message);
    this.name = 'TimeoutError';
    Error.captureStackTrace(this, TimeoutError);
  }
}

/**
 * Creates a timeout promise that rejects after specified milliseconds
 * Ensures the timer is properly cleaned up after resolve/reject
 */
function createTimeoutPromise(
  timeoutMs: number,
  operation: string,
  context?: Record<string, any>
): { promise: Promise<never>; cleanup: () => void } {
  let timeoutId: NodeJS.Timeout | null = null;
  let isCleanedUp = false;

  const cleanup = () => {
    if (!isCleanedUp && timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
      isCleanedUp = true;
    }
  };

  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      isCleanedUp = true;
      const error = new TimeoutError(
        `Operation timed out after ${timeoutMs}ms`,
        operation,
        timeoutMs,
        context
      );
      reject(error);
    }, timeoutMs);
  });

  return { promise, cleanup };
}

/**
 * Wraps a promise with a timeout, ensuring it resolves or rejects within the specified time
 * Uses Promise.race to prevent hanging operations
 * Cleans up timer resources properly to prevent memory leaks
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Name of the operation (for logging and error messages)
 * @param context - Additional context for logging (e.g., { providerId, accountId })
 * @returns Promise that resolves with the original result or rejects with TimeoutError
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   fetchData(),
 *   5000,
 *   'fetch-user-data',
 *   { userId: '123' }
 * );
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
  context?: Record<string, any>
): Promise<T> {
  const { promise: timeoutPromise, cleanup } = createTimeoutPromise(
    timeoutMs,
    operation,
    context
  );

  try {
    // Race between the operation and timeout
    const result = await Promise.race([promise, timeoutPromise]);
    cleanup(); // Clean up timeout if operation completed first
    return result;
  } catch (error) {
    cleanup(); // Clean up timeout in all cases

    // If it's a timeout error, log it with context
    if (error instanceof TimeoutError) {
      logger.error(
        {
          error: error.message,
          operation: error.operation,
          timeoutMs: error.timeoutMs,
          context: error.context,
        },
        'Operation timeout'
      );
    }

    throw error; // Re-throw the error (timeout or original error)
  }
}

/**
 * Wraps a function with automatic timeout enforcement
 * Useful for wrapping existing functions without modifying call sites extensively
 *
 * @param fn - The async function to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Name of the operation
 * @returns Wrapped function that enforces timeout
 *
 * @example
 * ```typescript
 * const safeFetch = withTimeoutWrapper(
 *   async (url: string) => fetch(url),
 *   5000,
 *   'http-fetch'
 * );
 *
 * const response = await safeFetch('https://api.example.com/data');
 * ```
 */
export function withTimeoutWrapper<TArgs extends any[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  timeoutMs: number,
  operation: string
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    return withTimeout(fn(...args), timeoutMs, operation);
  };
}

/**
 * Creates an AbortController with automatic timeout
 * Useful for operations that support AbortSignal
 *
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Name of the operation (for logging)
 * @returns Object with AbortController and cleanup function
 *
 * @example
 * ```typescript
 * const { controller, cleanup } = createAbortTimeout(5000, 'fetch-api');
 * try {
 *   const response = await fetch(url, { signal: controller.signal });
 *   cleanup();
 *   return response;
 * } catch (error) {
 *   cleanup();
 *   throw error;
 * }
 * ```
 */
export function createAbortTimeout(
  timeoutMs: number,
  operation: string
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | null = null;
  let isCleanedUp = false;

  const cleanup = () => {
    if (!isCleanedUp && timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
      isCleanedUp = true;
    }
  };

  timeoutId = setTimeout(() => {
    isCleanedUp = true;
    logger.warn(
      { operation, timeoutMs },
      'AbortController timeout triggered'
    );
    controller.abort(new TimeoutError(
      `Operation aborted due to timeout after ${timeoutMs}ms`,
      operation,
      timeoutMs
    ));
  }, timeoutMs);

  return { controller, cleanup };
}
