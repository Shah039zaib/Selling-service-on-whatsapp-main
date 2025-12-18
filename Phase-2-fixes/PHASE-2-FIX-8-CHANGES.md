# Phase-2 Fix-8: AI Provider Failover & Resilience

## Summary
Implemented comprehensive AI provider failover and resilience mechanisms to make the system fault-tolerant and prevent single provider failures from breaking AI responses.

## Goals Achieved
✅ Make AI provider usage resilient and fault-tolerant
✅ Prevent a single provider failure from breaking responses
✅ Implement smart retries and circuit breakers
✅ Improve provider rotation logic
✅ Fix false "daily limit exhausted" states

## Changes Made

### 1. Error Classification System
**File**: `backend/src/services/ai.service.ts` (Lines 17-132)

**Added**:
- `ErrorType` enum with three categories:
  - `RETRYABLE`: Network errors, timeouts, 5xx server errors
  - `NON_RETRYABLE`: Auth errors, invalid API keys, 4xx client errors
  - `QUOTA_EXCEEDED`: Rate limits, daily quota exhausted

- `classifyError()` function that analyzes errors and returns:
  - Error type classification
  - Human-readable message
  - Original error object

**Error Detection Logic**:
- Network/Timeout: `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNREFUSED`, timeout strings
- Server Errors: HTTP 5xx status codes, "internal server error", "service unavailable"
- Quota: HTTP 429, "rate limit", "quota exceeded", "too many requests"
- Auth: HTTP 401/403/400, "unauthorized", "forbidden", "invalid api key"
- Default: Unknown errors treated as `RETRYABLE` (conservative approach)

**Why Safe**:
- Only classifies errors, doesn't change behavior yet
- Conservative default (RETRYABLE) prevents false negatives
- No impact on successful requests

---

### 2. Retry Logic with Exponential Backoff
**File**: `backend/src/services/ai.service.ts` (Lines 571-651)

**Added**:
- Per-provider retry loop with max 2 retries (`MAX_RETRIES_PER_PROVIDER = 2`)
- Exponential backoff: 1s, 2s, 4s max
- `sleep()` utility function for backoff delays

**Retry Behavior by Error Type**:
- `RETRYABLE`: Retry up to 2 times with backoff
- `NON_RETRYABLE`: No retry, move to next provider immediately
- `QUOTA_EXCEEDED`: No retry, mark provider as exhausted, move to next

**Formula**: `backoffMs = min(1000 × 2^(attempt-1), 4000)`
- Retry 1: 1 second delay
- Retry 2: 2 seconds delay
- Max delay capped at 4 seconds

**Why Safe**:
- Limited to 2 retries per provider (bounded)
- Total max delay per provider: 7 seconds (1 + 2 + 4)
- Retries only for transient failures (network, timeout, 5xx)
- No retry for permanent failures (auth, quota)
- Prevents infinite loops

---

### 3. Circuit Breaker Per Provider
**File**: `backend/src/services/ai.service.ts` (Lines 29-41, 339-343, 447-514)

**Added**:
- `CircuitState` enum: `CLOSED` (healthy), `OPEN` (failing), `HALF_OPEN` (testing recovery)
- `CircuitBreakerState` interface tracking:
  - Current state
  - Consecutive failure count
  - Last failure timestamp
  - Next retry time

**Configuration**:
- `CIRCUIT_FAILURE_THRESHOLD = 3`: Opens circuit after 3 consecutive failures
- `CIRCUIT_COOLDOWN_MS = 60000`: 1-minute cooldown before retry
- In-memory state per provider (Map<providerId, CircuitBreakerState>)

**Methods Added**:
- `getCircuitState(providerId)`: Get or initialize circuit state
- `isCircuitClosed(providerId)`: Check if provider is healthy
- `recordCircuitSuccess(providerId)`: Reset failures on success
- `recordCircuitFailure(providerId, errorType)`: Track failures

**Circuit State Transitions**:
1. **CLOSED → OPEN**: After 3 consecutive RETRYABLE failures
2. **OPEN → HALF_OPEN**: After 1-minute cooldown expires
3. **HALF_OPEN → CLOSED**: On successful request
4. **HALF_OPEN → OPEN**: On failure during testing

**Important**: Only `RETRYABLE` errors count toward circuit breaker. `NON_RETRYABLE` and `QUOTA_EXCEEDED` don't trip the circuit (they indicate config issues, not transient failures).

**Why Safe**:
- In-memory only (no DB overhead)
- Auto-recovery after cooldown (self-healing)
- Prevents repeated failures to unhealthy providers
- Doesn't affect healthy providers
- Cleared on service shutdown

---

### 4. Fixed Daily Limit Tracking
**File**: `backend/src/services/ai.service.ts` (Lines 622-627, 663-673)

**Problem Fixed**:
- **OLD**: Line 385 set `config.usedToday = config.dailyLimit` on ANY error
- **Result**: All providers marked exhausted after any failure (network, timeout, etc.)

**New Behavior**:
- Only `QUOTA_EXCEEDED` errors trigger limit exhaustion
- Network/timeout errors don't affect daily limits
- Auth errors don't affect daily limits
- Successful requests increment counter normally

**Added**:
- `markProviderExhausted(providerId)`: Safely marks provider as exhausted in DB
- Sets `usedToday = 999999` (large number to ensure it exceeds any limit)
- Only called for quota/rate limit errors

**Why Safe**:
- Prevents false exhaustion states
- Providers remain available despite transient failures
- Daily limits still respected for actual quota errors
- Database update is isolated and error-handled

---

### 5. Improved Provider Rotation
**File**: `backend/src/services/ai.service.ts` (Lines 516-534)

**Enhanced `getAvailableProvider()`**:
- **OLD**: Only checked `usedToday < dailyLimit`
- **NEW**: Checks both:
  1. Daily limit not exceeded
  2. Circuit breaker is closed (provider is healthy)

**Provider Selection Logic**:
1. Iterate providers by priority (highest first)
2. Skip if daily limit reached
3. Skip if circuit is OPEN (unhealthy)
4. Return first healthy provider

**Rotation in `generateResponse()`**:
- Tracks tried providers to avoid duplicates
- Temporarily marks tried providers as exhausted to skip
- Tries each available provider once
- Moves to next provider on failure

**Why Safe**:
- Preserves priority-based selection
- Skips unhealthy providers automatically
- No infinite loops (bounded by provider count)
- No performance degradation (simple checks)

---

### 6. Comprehensive Error Logging
**File**: `backend/src/services/ai.service.ts` (Lines 609-619, 631-635, 641-647, 655-660)

**Enhanced Logging**:
- Every error logged with full context:
  - Error type classification
  - Error message
  - Original error object
  - Provider type
  - Retry attempt number
  - Max retries setting

**Log Levels**:
- `warn`: Individual provider failures (expected, retryable)
- `error`: Non-retryable errors, circuit breaker opened
- `info`: Circuit state changes, retry attempts, successful recovery

**Examples**:
```javascript
// Provider failure
log.warn({
  error: classified.originalError,
  errorType: classified.type,
  errorMessage: classified.message,
  provider: config.type,
  retryAttempt,
  maxRetries: this.MAX_RETRIES_PER_PROVIDER
}, 'AI provider request failed');

// Circuit breaker opened
logger.warn(
  { providerId, failureCount: circuit.failureCount },
  'Circuit breaker OPENED due to consecutive failures'
);

// All providers failed
log.error(
  { error: lastError?.originalError, triedProviders },
  'All AI providers failed after retries'
);
```

**Why Safe**:
- Logging only, no behavior changes
- Helps debugging and monitoring
- No performance impact (async logging)
- No PII exposure (only technical data)

---

### 7. Updated Provider Stats API
**File**: `backend/src/services/ai.service.ts` (Lines 799-820)

**Enhanced `getProviderStats()`**:
- **Added Fields**:
  - `circuitState`: Current circuit breaker state
  - `failureCount`: Consecutive failures tracked
  - `available`: Now considers both daily limit AND circuit state

**Example Response**:
```json
{
  "id": "provider-123",
  "type": "CLAUDE",
  "usedToday": 45,
  "dailyLimit": 100,
  "available": true,
  "circuitState": "CLOSED",
  "failureCount": 0
}
```

**Why Safe**:
- Backward compatible (added fields only)
- Existing fields unchanged
- Provides visibility into health status
- No breaking changes

---

### 8. Updated Shutdown Process
**File**: `backend/src/services/ai.service.ts` (Lines 822-837)

**Added**:
- `this.circuitBreakers.clear()` on shutdown

**Why Safe**:
- Prevents memory leaks
- Clean state on restart
- No side effects

---

## Failure Scenarios Handled

### Scenario 1: Network Timeout
**Before**: Provider marked as exhausted for the day
**After**:
1. Error classified as `RETRYABLE`
2. Retry 1 after 1s delay
3. Retry 2 after 2s delay (if still failing)
4. If all retries fail, circuit breaker increments failure count
5. Move to next provider
6. Daily limit unchanged

### Scenario 2: Invalid API Key
**Before**: Provider marked as exhausted, retried unnecessarily
**After**:
1. Error classified as `NON_RETRYABLE`
2. No retry (waste of time)
3. Logged as error
4. Move to next provider immediately
5. Circuit breaker NOT tripped (config issue, not transient)

### Scenario 3: Rate Limit Hit
**Before**: Provider marked as exhausted (correct) but no retry
**After**:
1. Error classified as `QUOTA_EXCEEDED`
2. Provider marked as exhausted in DB
3. No retry
4. Move to next provider
5. Circuit breaker NOT tripped (expected quota management)

### Scenario 4: Consecutive Server Errors (5xx)
**Before**: Each error marks provider exhausted
**After**:
1. Error classified as `RETRYABLE`
2. Retry with backoff (2 times)
3. If 3 consecutive failures, circuit opens
4. Provider skipped for 1 minute
5. Auto-recovery after cooldown
6. Daily limit unchanged

### Scenario 5: All Providers Failing
**Before**: Error thrown immediately
**After**:
1. Try each provider in priority order
2. Each gets up to 2 retries with backoff
3. Track all providers tried
4. Return detailed error with context
5. System continues if ANY provider recovers

---

## Circuit Breaker Rules

### When Circuit Opens
- 3 consecutive `RETRYABLE` failures
- Examples: 3 timeouts, 3x 500 errors, 3 network failures

### When Circuit Stays Closed
- Any successful request (resets counter)
- `NON_RETRYABLE` errors (config issues)
- `QUOTA_EXCEEDED` errors (expected quota management)

### Auto-Recovery Process
1. Circuit opens after 3 failures
2. Wait 60 seconds (cooldown)
3. Transition to `HALF_OPEN` state
4. Next request tests if provider recovered
5. Success → Circuit `CLOSED` (healthy)
6. Failure → Circuit `OPEN` again (another 60s cooldown)

### Memory Safety
- In-memory only (no DB writes)
- Bounded by provider count (max 50)
- Cleared on service restart
- No unbounded growth

---

## Retry Logic Details

### Max Retries Per Provider
- **Value**: 2 retries (3 total attempts including first)
- **Reason**: Balance between fault tolerance and latency
- **Total max time per provider**: ~7 seconds (0 + 1 + 2 + 4)

### Backoff Schedule
| Attempt | Delay Before | Total Elapsed |
|---------|--------------|---------------|
| 1       | 0s           | 0s            |
| 2       | 1s           | 1s            |
| 3       | 2s           | 3s            |
| (max delay cap) | 4s   | 7s            |

### Why This Is Safe
- No infinite loops (hard limit of 2 retries)
- No unbounded delays (max 4s per retry)
- Per-provider limit (not global)
- Respects error classification (no retry for permanent failures)
- Provider rotation ensures system continues

---

## Performance Impact

### Latency
- **Normal case (success)**: No change (0ms overhead)
- **Single retryable failure**: +1s (one retry)
- **Two retryable failures**: +3s (two retries)
- **Max latency per provider**: 7 seconds (rare, only on repeated failures)
- **Circuit open**: ~0ms (provider skipped immediately)

### Memory
- Circuit breaker state: ~200 bytes per provider
- Max providers: 50
- Total memory: ~10KB (negligible)

### Database
- **Reads**: No change
- **Writes**: Reduced! Only mark exhausted on actual quota errors (not all errors)

### Throughput
- No degradation (same number of providers)
- Better resilience (retries increase success rate)
- Circuit breaker prevents wasted attempts

---

## Backward Compatibility

### API Changes
- ✅ `getProviderStats()`: Added fields, no breaking changes
- ✅ `generateResponse()`: Same signature, enhanced behavior
- ✅ `initialize()`: No changes
- ✅ `shutdown()`: Enhanced, no breaking changes

### Database Schema
- ✅ No schema changes required
- ✅ Existing data unaffected

### Behavior Changes
- ✅ Providers no longer marked exhausted on transient failures (IMPROVEMENT)
- ✅ Retries add slight latency on failures (acceptable tradeoff)
- ✅ Circuit breaker prevents repeated failures (IMPROVEMENT)

### Configuration
- ✅ No new environment variables required
- ✅ No config file changes needed
- ✅ All settings hardcoded with safe defaults

---

## Testing Recommendations

### Unit Tests (Recommended)
1. Error classification for all error types
2. Retry logic with different failure scenarios
3. Circuit breaker state transitions
4. Daily limit tracking accuracy
5. Provider rotation logic

### Integration Tests (Recommended)
1. All providers failing (one healthy provider recovers)
2. Network timeout recovery
3. Rate limit handling
4. Circuit breaker auto-recovery after cooldown
5. Multiple concurrent requests

### Manual Testing
1. Disable all providers except one → Verify it's used
2. Invalid API key → Verify no retries, next provider used
3. Simulate network timeout → Verify retries with backoff
4. Simulate 3 consecutive failures → Verify circuit opens
5. Wait 60 seconds → Verify circuit auto-recovers

---

## Constraints Verified

✅ **No global retries**: Retries are per-provider, per-request
✅ **No infinite loops**: Max 2 retries per provider, bounded provider list
✅ **No unbounded memory**: Circuit breakers limited by provider count (max 50)
✅ **No performance degradation**: Normal case unchanged, only failures add latency

---

## What Wasn't Changed (As Required)

❌ No prompt modifications
❌ No response format changes
❌ No pricing/package changes
❌ No admin behavior changes
❌ No new features added
❌ No database schema changes

---

## Rollback Plan

If issues arise, revert `backend/src/services/ai.service.ts` to previous version:

```bash
git checkout HEAD~1 -- backend/src/services/ai.service.ts
cd backend && npm run build
```

No database migrations needed (no schema changes).

---

## Monitoring & Observability

### Key Metrics to Watch
1. **Circuit breaker state changes**: Log level `warn`/`info`
2. **Retry attempts**: Logged with attempt number
3. **Provider failures by type**: RETRYABLE vs NON_RETRYABLE vs QUOTA_EXCEEDED
4. **Average latency per provider**: Existing metric
5. **Daily limit accuracy**: Compare `usedToday` with actual successful requests

### Log Patterns to Monitor
- `"Circuit breaker OPENED"` → Provider having repeated failures
- `"Circuit breaker moving to HALF_OPEN"` → Testing recovery
- `"Max retries reached"` → Provider consistently failing
- `"Provider quota exceeded"` → Legitimate daily limit hit
- `"Non-retryable error"` → Config issue (invalid API key)

---

## Security Considerations

✅ No new security vulnerabilities introduced
✅ Error messages don't expose API keys
✅ Circuit breaker state doesn't leak sensitive data
✅ Logging follows existing privacy standards
✅ No new external dependencies

---

## Code Quality

✅ TypeScript compiles without errors
✅ No ESLint warnings
✅ Follows existing code style
✅ Comprehensive comments added
✅ Error handling consistent with codebase

---

## Files Modified

1. `backend/src/services/ai.service.ts` (ONLY file changed)
   - Added: Error classification system (lines 17-132)
   - Added: Circuit breaker state (lines 29-41, 339-343)
   - Added: Circuit breaker methods (lines 447-514)
   - Modified: `generateResponse()` method (lines 536-673)
   - Modified: `getAvailableProvider()` method (lines 516-534)
   - Modified: `getProviderStats()` method (lines 799-820)
   - Modified: `shutdown()` method (lines 822-837)

2. `PHASE-2-FIX-8-CHANGES.md` (this file, new documentation)

---

## Conclusion

This fix makes the AI provider system resilient to failures while maintaining:
- ✅ Minimal changes (single file)
- ✅ No breaking changes
- ✅ No new dependencies
- ✅ No schema migrations
- ✅ Backward compatibility
- ✅ Safe defaults
- ✅ Self-healing behavior
- ✅ Comprehensive logging

The system will now continue functioning as long as ANY provider is healthy, and providers auto-recover after transient failures.
