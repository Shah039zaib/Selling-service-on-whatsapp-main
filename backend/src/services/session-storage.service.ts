import { AuthenticationState, AuthenticationCreds } from 'baileys';
import crypto from 'crypto';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { logger, createChildLogger } from '../utils/logger.js';

/**
 * Encrypted session storage service using AES-256-GCM
 * Stores WhatsApp session data securely in the database
 */

interface EncryptedData {
  iv: string;
  authTag: string;
  encrypted: string;
}

/**
 * Encrypts data using AES-256-GCM
 */
function encryptData(data: string, secret: string): EncryptedData {
  try {
    // Derive a 32-byte key from the secret
    const key = crypto.scryptSync(secret, 'whatsapp-session-salt', 32);

    // Generate a random 12-byte IV (recommended for GCM)
    const iv = crypto.randomBytes(12);

    // Create cipher
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    // Encrypt the data
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Get the auth tag
    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      encrypted,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to encrypt session data');
    throw new Error('Session encryption failed');
  }
}

/**
 * Decrypts data using AES-256-GCM
 */
function decryptData(encryptedData: EncryptedData, secret: string): string {
  try {
    // Derive the same 32-byte key
    const key = crypto.scryptSync(secret, 'whatsapp-session-salt', 32);

    // Convert hex strings back to buffers
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const authTag = Buffer.from(encryptedData.authTag, 'hex');

    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    // Decrypt the data
    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    logger.error({ error }, 'Failed to decrypt session data');
    throw new Error('Session decryption failed');
  }
}

/**
 * Database-backed authentication state for Baileys
 * Replaces filesystem-based useMultiFileAuthState
 */
export async function useDatabaseAuthState(
  accountId: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const log = createChildLogger({ accountId, service: 'session-storage' });

  // Load existing session from database
  let sessionData: { creds: Partial<AuthenticationCreds>; keys: { [key: string]: any } } = {
    creds: {} as any,
    keys: {},
  };

  try {
    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
      select: { sessionData: true },
    });

    if (account?.sessionData) {
      log.info('Loading existing session from database');

      // Decrypt the session data
      const encryptedData: EncryptedData = JSON.parse(account.sessionData);
      const decryptedJson = decryptData(encryptedData, env.WHATSAPP_SESSION_SECRET);
      sessionData = JSON.parse(decryptedJson);

      // Convert Buffer-like objects back to actual Buffers
      if (sessionData.creds) {
        sessionData.creds = deserializeBuffers(sessionData.creds) as Partial<AuthenticationCreds>;
      }

      log.info('Session loaded and decrypted successfully');
    } else {
      log.info('No existing session found, starting fresh');
    }
  } catch (error) {
    log.error({ error }, 'Failed to load session from database, starting fresh');
    sessionData = {
      creds: {} as any,
      keys: {},
    };
  }

  /**
   * Saves credentials to the database (encrypted)
   */
  const saveCreds = async () => {
    try {
      // Serialize the session data (convert Buffers to base64)
      const serializedData = {
        creds: serializeBuffers(sessionData.creds),
        keys: sessionData.keys,
      };

      // Convert to JSON
      const jsonData = JSON.stringify(serializedData);

      // Encrypt the JSON data
      const encrypted = encryptData(jsonData, env.WHATSAPP_SESSION_SECRET);

      // Store in database
      await prisma.whatsAppAccount.update({
        where: { id: accountId },
        data: { sessionData: JSON.stringify(encrypted) },
      });

      log.debug('Session credentials saved to database');
    } catch (error) {
      log.error({ error }, 'Failed to save session credentials');
      throw error;
    }
  };

  /**
   * Authentication state object
   */
  const state: AuthenticationState = {
    creds: sessionData.creds as AuthenticationCreds,
    keys: {
      get: async (type: string, ids: string[]) => {
        const data: { [id: string]: any } = {};

        for (const id of ids) {
          const key = `${type}-${id}`;
          const value = sessionData.keys[key];

          if (value) {
            // Deserialize buffers if needed
            data[id] = deserializeBuffers(value);
          }
        }

        return data;
      },

      set: async (data: any) => {
        for (const category in data) {
          for (const id in data[category]) {
            const key = `${category}-${id}`;
            const value = data[category][id];

            if (value === null || value === undefined) {
              delete sessionData.keys[key];
            } else {
              // Serialize buffers before storing
              sessionData.keys[key] = serializeBuffers(value);
            }
          }
        }

        // Auto-save when keys are updated
        await saveCreds();
      },
    },
  };

  return { state, saveCreds };
}

/**
 * Recursively converts Buffers to base64 strings for serialization
 */
function serializeBuffers(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Buffer.isBuffer(obj)) {
    return {
      type: 'Buffer',
      data: obj.toString('base64'),
    };
  }

  if (obj instanceof Uint8Array) {
    return {
      type: 'Buffer',
      data: Buffer.from(obj).toString('base64'),
    };
  }

  if (Array.isArray(obj)) {
    return obj.map(serializeBuffers);
  }

  if (typeof obj === 'object') {
    const serialized: any = {};
    for (const key in obj) {
      serialized[key] = serializeBuffers(obj[key]);
    }
    return serialized;
  }

  return obj;
}

/**
 * Recursively converts base64 strings back to Buffers
 */
function deserializeBuffers(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (obj.type === 'Buffer' && typeof obj.data === 'string') {
    return Buffer.from(obj.data, 'base64');
  }

  if (Array.isArray(obj)) {
    return obj.map(deserializeBuffers);
  }

  if (typeof obj === 'object') {
    const deserialized: any = {};
    for (const key in obj) {
      deserialized[key] = deserializeBuffers(obj[key]);
    }
    return deserialized;
  }

  return obj;
}

/**
 * Clears session data from database (for logout)
 */
export async function clearDatabaseSession(accountId: string): Promise<void> {
  const log = createChildLogger({ accountId, service: 'session-storage' });

  try {
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { sessionData: null },
    });

    log.info('Session data cleared from database');
  } catch (error) {
    log.error({ error }, 'Failed to clear session data');
    throw error;
  }
}
