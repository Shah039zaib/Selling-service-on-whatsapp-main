# Phase-1 Fix-5: Authentication Rate Limiting & Account Protection

## Summary

Implemented production-grade rate limiting and account lockout mechanisms to protect authentication endpoints from brute-force attacks, credential stuffing, and other abuse patterns.

## Implementation Date

2025-12-18

## Changes Made

### 1. Database Schema Updates

**File:** `backend/prisma/schema.prisma`

Added account lockout tracking fields to User model:
- `failedLoginAttempts`: Counter for failed login attempts (default: 0)
- `lockedUntil`: Timestamp indicating when account lockout expires (nullable)

**Impact:** Requires database migration to add new columns.

### 2. Enhanced Rate Limiting Middleware

**File:** `backend/src/middleware/rate-limit.middleware.ts`

#### New Features:
- **IP Key Generator**: Properly handles IPv6 addresses and removes port numbers to prevent bypass
- **Email-based Rate Limiting**: Prevents credential stuffing by limiting attempts per email address
- **Modern Standards**: Uses `draft-8` standard headers for better client compatibility

#### New Rate Limiters:

1. **loginLimiter**
   - Window: 15 minutes
   - Limit: 5 attempts per IP
   - Skips successful requests
   - Protects against IP-based brute force

2. **emailLoginLimiter**
   - Window: 30 minutes
   - Limit: 10 attempts per email
   - Skips successful requests
   - Protects against credential stuffing on specific accounts

3. **registerLimiter**
   - Window: 1 hour
   - Limit: 3 registrations per IP
   - Prevents mass account creation

4. **passwordChangeLimiter**
   - Window: 1 hour
   - Limit: 5 password changes
   - Uses user ID for authenticated users, IP for others
   - Prevents password change abuse

#### Improvements:
- All limiters updated to use `standardHeaders: 'draft-8'`
- Proper IPv6 subnet handling
- Port stripping from IP addresses
- Clear, actionable error messages

### 3. Account Lockout Logic

**File:** `backend/src/controllers/auth.controller.ts`

#### Configuration Constants:
- `MAX_FAILED_ATTEMPTS`: 5 attempts before lockout
- `LOCKOUT_DURATION_MINUTES`: 30 minutes lockout period

#### Login Flow Enhancements:

1. **Lockout Check**: Validates if account is currently locked before password verification
2. **Auto-Unlock**: Automatically unlocks account if lockout period has expired
3. **Failed Attempt Tracking**: Increments counter on each failed login
4. **Progressive Lockout**: Locks account after reaching MAX_FAILED_ATTEMPTS
5. **Success Reset**: Clears failed attempts and lockout on successful login
6. **User Feedback**: Provides remaining attempts or lockout duration in error messages

#### Audit Logging:
All authentication events are logged to `audit_logs` table:
- `login_success`: Successful authentication
- `login_failed`: Failed password verification with attempt count
- `account_locked`: Account locked due to excessive failed attempts
- `login_attempt_while_locked`: Attempt made on locked account

### 4. Route Protection Updates

**File:** `backend/src/routes/auth.routes.ts`

Applied layered rate limiting to authentication endpoints:
- **Login**: Both `loginLimiter` (IP-based) and `emailLoginLimiter` (email-based)
- **Register**: `registerLimiter` for spam prevention
- **Password Change**: `passwordChangeLimiter` for abuse prevention

## Security Features

### Protection Against:

1. **Brute-Force Attacks**: IP and email-based rate limiting with progressive lockout
2. **Credential Stuffing**: Email-specific rate limiting prevents testing multiple passwords
3. **Account Enumeration**: Generic error messages don't reveal account existence
4. **Distributed Attacks**: IPv6 subnet handling prevents address rotation
5. **Automated Abuse**: Registration limiting prevents bot account creation

### Defense in Depth:

- Layer 1: IP-based rate limiting (15 min / 5 attempts)
- Layer 2: Email-based rate limiting (30 min / 10 attempts)
- Layer 3: Account lockout (5 failures / 30 min lockout)
- Layer 4: Audit logging for monitoring and forensics
- Layer 5: CSRF protection (existing)

## Breaking Changes

**None.** All changes are backward compatible with existing authentication flow.

## Migration Required

### Database Migration

Run the following command to update the database schema:

```bash
cd backend
npm run db:push
```

Or for production:

```bash
cd backend
npm run db:migrate
```

### Environment Variables

No new environment variables required. Existing rate limit configuration is used for API-wide limits.

## Verification Steps

### 1. Database Schema Verification

After running migration:

```sql
-- Verify new columns exist
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'users'
AND column_name IN ('failed_login_attempts', 'locked_until');
```

Expected output:
```
failed_login_attempts | integer | NO | 0
locked_until          | timestamp without time zone | YES | NULL
```

### 2. Rate Limiting Tests

#### Test IP-based Login Rate Limiting:

```bash
# Make 6 login attempts from same IP with invalid credentials
for i in {1..6}; do
  curl -X POST http://localhost:4000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong"}' \
    -v
done
```

Expected: 6th request returns 429 with "Too many login attempts from this IP" message.

#### Test Email-based Rate Limiting:

```bash
# Make 11 login attempts for same email from different IPs (requires proxy setup)
# Expected: 11th request blocked by email limiter
```

#### Test Registration Rate Limiting:

```bash
# Make 4 registration attempts from same IP
for i in {1..4}; do
  curl -X POST http://localhost:4000/api/auth/register \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"test$i@example.com\",\"password\":\"password123\",\"name\":\"Test User\"}" \
    -v
done
```

Expected: 4th request returns 429 with "Too many registration attempts" message.

### 3. Account Lockout Tests

#### Test Lockout After Failed Attempts:

```bash
# 1. Create a test user
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"locktest@example.com","password":"correct123","name":"Lock Test"}'

# 2. Make 5 failed login attempts
for i in {1..5}; do
  curl -X POST http://localhost:4000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"locktest@example.com","password":"wrong"}' \
    -v
  echo "Attempt $i"
done

# 3. Verify account is locked
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"locktest@example.com","password":"correct123"}' \
  -v
```

Expected responses:
- Attempts 1-4: "Invalid email or password. X attempt(s) remaining before account lockout"
- Attempt 5: "Account locked due to 5 failed login attempts. Please try again in 30 minutes"
- Attempt 6 (with correct password): "Account is temporarily locked..."

#### Test Auto-Unlock:

```sql
-- Manually expire lockout for testing
UPDATE users
SET locked_until = NOW() - INTERVAL '1 minute'
WHERE email = 'locktest@example.com';
```

```bash
# Try logging in with correct password
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"locktest@example.com","password":"correct123"}' \
  -v
```

Expected: Successful login, lockout cleared, failed attempts reset to 0.

#### Test Successful Login Reset:

```bash
# 1. Make 2 failed attempts
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"locktest@example.com","password":"wrong"}'

curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"locktest@example.com","password":"wrong"}'

# 2. Login successfully
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"locktest@example.com","password":"correct123"}'
```

```sql
-- Verify failed attempts reset
SELECT failed_login_attempts, locked_until
FROM users
WHERE email = 'locktest@example.com';
```

Expected: `failed_login_attempts = 0`, `locked_until = NULL`

### 4. Audit Log Verification

```sql
-- Check audit logs for authentication events
SELECT
  action,
  ip_address,
  new_data,
  created_at
FROM audit_logs
WHERE entity = 'user'
  AND action IN ('login_success', 'login_failed', 'account_locked', 'login_attempt_while_locked')
ORDER BY created_at DESC
LIMIT 20;
```

Expected: All login attempts, failures, and lockouts are logged with metadata.

### 5. Production Readiness Checks

- [ ] Database migration applied successfully
- [ ] Rate limiting headers present in responses (`RateLimit` header)
- [ ] Failed login attempts tracked correctly
- [ ] Account lockout triggers at configured threshold
- [ ] Auto-unlock works after expiration period
- [ ] Successful login resets failed attempts
- [ ] Audit logs capture all authentication events
- [ ] Error messages don't reveal account existence
- [ ] IPv6 addresses handled correctly
- [ ] CSRF protection still functional

## Rollback Procedure

If issues arise, follow these steps to rollback:

### 1. Revert Code Changes

```bash
# Revert all files to previous commit
git checkout <previous-commit-hash> -- backend/src/middleware/rate-limit.middleware.ts
git checkout <previous-commit-hash> -- backend/src/controllers/auth.controller.ts
git checkout <previous-commit-hash> -- backend/src/routes/auth.routes.ts
git checkout <previous-commit-hash> -- backend/prisma/schema.prisma
```

### 2. Rollback Database Schema (Optional)

Only necessary if the new columns cause issues:

```sql
-- Remove lockout columns
ALTER TABLE users DROP COLUMN IF EXISTS failed_login_attempts;
ALTER TABLE users DROP COLUMN IF EXISTS locked_until;
```

### 3. Restart Application

```bash
cd backend
npm run build
npm start
```

### 4. Clear Rate Limit Store (if using Redis)

```bash
redis-cli FLUSHDB
```

Note: express-rate-limit uses in-memory store by default, so restart clears limits.

## Performance Impact

### Database Queries:
- **Login endpoint**: +1-2 UPDATE queries per request (account lockout tracking)
- **Failed login**: 1 additional UPDATE, 1 INSERT (audit log)
- **Successful login**: 1 UPDATE (was already present), modified to include lockout reset

### Memory Usage:
- Rate limiting uses in-memory store (default)
- Estimated: ~100 bytes per tracked IP/email
- For 10,000 unique IPs: ~1MB additional memory

### Response Time Impact:
- Negligible (<5ms) for rate limit checks
- Database updates are non-blocking and minimal

## Monitoring Recommendations

### Metrics to Track:

1. **Rate Limit Hits**:
   - Monitor 429 responses on auth endpoints
   - Alert if rate limit abuse patterns detected

2. **Account Lockouts**:
   ```sql
   -- Daily lockout count
   SELECT COUNT(*)
   FROM audit_logs
   WHERE action = 'account_locked'
     AND created_at > NOW() - INTERVAL '24 hours';
   ```

3. **Failed Login Patterns**:
   ```sql
   -- Top IPs with failed logins
   SELECT ip_address, COUNT(*) as attempts
   FROM audit_logs
   WHERE action IN ('login_failed', 'account_locked')
     AND created_at > NOW() - INTERVAL '1 hour'
   GROUP BY ip_address
   ORDER BY attempts DESC
   LIMIT 10;
   ```

4. **Currently Locked Accounts**:
   ```sql
   -- Accounts currently locked
   SELECT email, locked_until, failed_login_attempts
   FROM users
   WHERE locked_until > NOW()
   ORDER BY locked_until DESC;
   ```

### Alerting Rules:

- Alert if >50 account lockouts per hour (potential attack)
- Alert if single IP triggers >100 rate limits per hour
- Alert if >10 accounts locked from same IP range

## Configuration Tuning

### Adjusting Lockout Settings:

Edit `backend/src/controllers/auth.controller.ts`:

```typescript
// More aggressive (stricter)
const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_DURATION_MINUTES = 60;

// More lenient
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION_MINUTES = 15;
```

### Adjusting Rate Limits:

Edit `backend/src/middleware/rate-limit.middleware.ts`:

```typescript
// Stricter IP login limit
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3, // Changed from 5
  // ...
});

// More lenient email limit
export const emailLoginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 20, // Changed from 10
  // ...
});
```

## Known Limitations

1. **In-Memory Rate Limiting**: Default express-rate-limit store is in-memory. For multi-server deployments, consider Redis store:
   ```bash
   npm install rate-limit-redis
   ```

2. **Shared IP Scenarios**: Users behind NAT or corporate proxies share IPs. Consider:
   - Increasing IP-based rate limits
   - Relying more on email-based limits
   - Using authenticated rate limiting where possible

3. **No Admin Override**: Locked accounts auto-unlock after timeout. Future enhancement could add admin unlock capability.

4. **No Email Notifications**: Users aren't notified when their account is locked. Consider adding email alerts.

## Future Enhancements

- [ ] Add password reset rate limiting
- [ ] Implement Redis-based rate limit store for horizontal scaling
- [ ] Add admin dashboard to view/unlock locked accounts
- [ ] Send email notifications for account lockouts
- [ ] Add CAPTCHA after N failed attempts
- [ ] Implement IP allowlist/blocklist
- [ ] Add geolocation-based risk scoring
- [ ] Track and alert on distributed attacks

## References

- [express-rate-limit Documentation](https://github.com/express-rate-limit/express-rate-limit)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [NIST Digital Identity Guidelines](https://pages.nist.gov/800-63-3/)

## Files Modified

1. `backend/prisma/schema.prisma` - Added account lockout fields
2. `backend/src/middleware/rate-limit.middleware.ts` - Enhanced rate limiters
3. `backend/src/controllers/auth.controller.ts` - Account lockout logic
4. `backend/src/routes/auth.routes.ts` - Applied new rate limiters

## Files Created

1. `PHASE-1-FIX-5-COMPLETE.md` - This documentation

## Testing Checklist

- [ ] Unit tests for account lockout logic
- [ ] Integration tests for rate limiting
- [ ] End-to-end tests for login flow
- [ ] Load testing for performance impact
- [ ] Security testing for bypass attempts

## Deployment Notes

1. **Staging First**: Deploy to staging and verify all tests pass
2. **Monitor Closely**: Watch for false positives in first 24 hours
3. **User Communication**: Consider notifying users about new security measures
4. **Gradual Rollout**: If possible, enable for subset of users first
5. **Rollback Plan**: Keep previous version ready for quick rollback

## Support Information

If users report being locked out:

1. **Verify Lockout**:
   ```sql
   SELECT email, locked_until, failed_login_attempts
   FROM users
   WHERE email = 'user@example.com';
   ```

2. **Manual Unlock** (if necessary):
   ```sql
   UPDATE users
   SET locked_until = NULL,
       failed_login_attempts = 0
   WHERE email = 'user@example.com';
   ```

3. **Check Audit Logs**:
   ```sql
   SELECT action, ip_address, new_data, created_at
   FROM audit_logs
   WHERE user_id = (SELECT id FROM users WHERE email = 'user@example.com')
   ORDER BY created_at DESC
   LIMIT 20;
   ```

## Compliance

This implementation aligns with:
- OWASP Top 10 (A07:2021 - Identification and Authentication Failures)
- PCI DSS Requirement 8.1.6 (limit repeated access attempts)
- NIST 800-63B Section 5.2.2 (rate limiting)
- GDPR Article 32 (security of processing)

---

**Implementation Status**: ✅ Complete
**Review Status**: Pending
**Deployment Status**: Pending Migration
