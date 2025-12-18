# Security Fix #2: AI Provider API Key Encryption

## Implementation Summary

This fix encrypts AI provider API keys before storing them in the database and decrypts them only in memory when needed. Keys are never stored in plaintext.

## Changes Made

### 1. `src/utils/encryption.ts` (NEW FILE)
- **Created**: Encryption utilities for API keys
- **Function**: `encryptApiKey()` - Encrypts API keys using AES-256-CBC
- **Function**: `decryptApiKey()` - Decrypts API keys from database
- **Security**: Uses WHATSAPP_SESSION_SECRET as encryption key base
- **Format**: Encrypted keys stored as "iv:encryptedData" in hex

### 2. `src/services/ai.service.ts`
- **Added**: Import for `decryptApiKey` utility
- **Modified**: `loadProviders()` method to decrypt keys when loading
- **Added**: Error handling to skip providers if decryption fails
- **Impact**: Keys only exist decrypted in memory, never persisted

### 3. `src/controllers/ai-providers.controller.ts`
- **Added**: Import for `encryptApiKey` utility
- **Modified**: `createProvider()` to encrypt keys before saving
- **Modified**: `updateProvider()` to encrypt keys if being updated
- **Impact**: All new/updated keys are automatically encrypted

### 4. `src/scripts/encrypt-api-keys.ts` (NEW FILE)
- **Created**: One-time migration script for existing keys
- **Function**: Encrypts all plaintext keys in database
- **Safety**: Skips already-encrypted keys (contains ':')
- **Logging**: Detailed progress and error reporting

### 5. `package.json`
- **Added**: `encrypt-keys` script for easy migration execution

## Security Benefits

✅ **Encryption at Rest**: API keys encrypted in database using AES-256-CBC

✅ **Memory-Only Decryption**: Keys only decrypted when loading providers into memory

✅ **Automatic Encryption**: All new/updated keys encrypted automatically

✅ **Graceful Failures**: Providers with decryption errors are skipped, not crash app

✅ **Migration Script**: Safe one-time migration for existing deployments

✅ **No Plaintext Exposure**: Keys never logged or returned in API responses

## Verification Steps

### Test 1: Verify Encryption Utilities

```bash
cd backend

# Test encryption/decryption in Node REPL
node --loader tsx --no-warnings

> const { encryptApiKey, decryptApiKey } = await import('./src/utils/encryption.js');
> const testKey = 'sk-ant-test123456789';
> const encrypted = encryptApiKey(testKey);
> console.log('Encrypted:', encrypted);
> // Should see format: "abc123:def456..."
> const decrypted = decryptApiKey(encrypted);
> console.log('Decrypted:', decrypted);
> // Should match original: sk-ant-test123456789
```

### Test 2: Create New Provider with Encryption

```bash
# Start the backend
npm run dev

# In another terminal, create a provider via API
curl -X POST http://localhost:3001/api/ai-providers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Test Claude",
    "type": "CLAUDE",
    "apiKey": "sk-ant-test123",
    "dailyLimit": 100
  }'
```

**Verify in Database:**
```sql
SELECT id, name, type, api_key FROM ai_providers WHERE name='Test Claude';
```

**Expected Result**: `api_key` column shows encrypted format with colon separator (not plaintext)

### Test 3: Run Migration on Existing Keys

```bash
cd backend

# Backup database first!
pg_dump $DATABASE_URL > backup_before_key_encryption.sql

# Run migration
npm run encrypt-keys
```

**Expected Output:**
```
Starting API key encryption migration...
Found AI providers to process
Key encrypted successfully
API key encryption migration complete
Migration completed successfully
```

**Verify in Database:**
```sql
SELECT id, name, type, LEFT(api_key, 40) as encrypted_preview
FROM ai_providers;
```

**Expected Result**: All `api_key` values should be in hex format with colon (e.g., "a1b2c3:d4e5f6...")

### Test 4: Application Startup with Encrypted Keys

```bash
# Restart backend after migration
npm run dev
```

**Check logs for:**
```
AI service initialized
```

**Should NOT see:**
```
Failed to decrypt API key
```

**Expected Result**: Application starts successfully, AI providers loaded

### Test 5: Test AI Generation with Encrypted Keys

```bash
# Send a WhatsApp message that triggers AI
# Check logs for AI provider usage

# Should see:
# "AI response generated" with provider type
```

**Expected Result**: AI responses work normally, keys decrypted successfully in memory

### Test 6: Test Decryption Failure Handling

```bash
# Manually corrupt a key in database to test error handling
psql $DATABASE_URL
UPDATE ai_providers SET api_key='invalid' WHERE name='Test Claude';
\q

# Restart backend
npm run dev
```

**Check logs for:**
```
Failed to decrypt API key, skipping provider
```

**Expected Result**:
- Application starts without crashing
- Corrupted provider skipped
- Other providers load successfully

### Test 7: Update Provider Key

```bash
curl -X PATCH http://localhost:3001/api/ai-providers/{id} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "apiKey": "sk-ant-newkey456"
  }'
```

**Verify in Database:**
```sql
SELECT api_key FROM ai_providers WHERE id='{id}';
```

**Expected Result**: New key is encrypted, different from old encrypted value

## Security Validation Checklist

- [ ] Encryption utilities created and working
- [ ] New providers save with encrypted keys
- [ ] Existing keys migrated to encrypted format
- [ ] Application starts with encrypted keys
- [ ] AI providers load and decrypt keys successfully
- [ ] Decryption failures handled gracefully
- [ ] Updated keys are re-encrypted
- [ ] No plaintext keys in database
- [ ] No plaintext keys in logs
- [ ] No plaintext keys in API responses (masked)

## Migration Procedure for Production

### Pre-Migration

1. **Backup Database:**
   ```bash
   pg_dump $DATABASE_URL > backup_pre_key_encryption_$(date +%Y%m%d_%H%M%S).sql
   ```

2. **Test on Staging:**
   - Run migration on staging environment first
   - Verify application functionality
   - Test AI provider operations

3. **Maintenance Window:**
   - Schedule 15-minute maintenance window
   - Notify users of temporary unavailability

### Migration Steps

1. **Stop Application:**
   ```bash
   pm2 stop backend
   ```

2. **Pull Latest Code:**
   ```bash
   git pull origin main
   cd backend
   npm install
   ```

3. **Run Migration:**
   ```bash
   npm run encrypt-keys
   ```

4. **Verify Migration:**
   ```bash
   # Check database for encrypted keys
   psql $DATABASE_URL -c "SELECT COUNT(*) FROM ai_providers WHERE api_key LIKE '%:%';"
   # Should match total provider count
   ```

5. **Start Application:**
   ```bash
   npm run build
   pm2 start dist/index.js --name backend
   ```

6. **Verify Functionality:**
   ```bash
   # Check logs
   pm2 logs backend --lines 50

   # Test health endpoint
   curl http://localhost:3001/health

   # Test AI provider loading
   # Send test WhatsApp message
   ```

### Post-Migration

- [ ] Verify all AI providers loaded successfully
- [ ] Test AI responses in WhatsApp
- [ ] Monitor logs for decryption errors
- [ ] Confirm no plaintext keys in database
- [ ] Delete backup after 7 days if all is well

## Rollback Procedure

If issues occur:

```bash
# 1. Stop application
pm2 stop backend

# 2. Restore database
psql $DATABASE_URL < backup_pre_key_encryption_*.sql

# 3. Revert code
git checkout HEAD~1 -- src/utils/encryption.ts
git checkout HEAD~1 -- src/services/ai.service.ts
git checkout HEAD~1 -- src/controllers/ai-providers.controller.ts
git checkout HEAD~1 -- src/scripts/encrypt-api-keys.ts
git checkout HEAD~1 -- package.json

# 4. Rebuild and restart
npm run build
pm2 start backend

# 5. Verify
pm2 logs backend
```

## Troubleshooting

### Issue: "API key encryption failed"
**Cause**: WHATSAPP_SESSION_SECRET not set or too short
**Fix**: Ensure WHATSAPP_SESSION_SECRET is at least 16 characters in .env

### Issue: "API key decryption failed"
**Cause**: Key was encrypted with different SECRET
**Fix**: Use same WHATSAPP_SESSION_SECRET that encrypted the keys

### Issue: Migration shows "Failed to encrypt key"
**Cause**: Invalid key format or database connection issue
**Fix**: Check logs for specific error, verify database connectivity

### Issue: "No AI providers available"
**Cause**: All providers failed decryption
**Fix**: Check WHATSAPP_SESSION_SECRET matches what was used for encryption

## Notes

- Encryption uses WHATSAPP_SESSION_SECRET as base key
- Same SECRET must be used across all instances
- Changing SECRET will invalidate all encrypted keys
- Migration script is idempotent (safe to run multiple times)
- Already-encrypted keys are skipped automatically

## Next Steps

After verifying this fix:
1. Monitor logs for any decryption errors
2. Verify AI responses are working
3. Proceed to Phase-1 Fix #3 if needed
4. Consider implementing key rotation mechanism in future
