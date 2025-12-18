import crypto from 'crypto';
import { env } from '../config/env.js';

// Encryption configuration for API keys
const API_KEY_ALGORITHM = 'aes-256-cbc';
const API_KEY_IV_LENGTH = 16;

/**
 * Encrypts an API key for secure storage in the database
 * @param apiKey - The plaintext API key to encrypt
 * @returns Encrypted key in format "iv:encryptedData"
 */
export function encryptApiKey(apiKey: string): string {
  try {
    // Use first 32 bytes of session secret as encryption key
    const key = crypto
      .createHash('sha256')
      .update(env.WHATSAPP_SESSION_SECRET)
      .digest();

    const iv = crypto.randomBytes(API_KEY_IV_LENGTH);
    const cipher = crypto.createCipheriv(API_KEY_ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
      cipher.update(apiKey, 'utf8'),
      cipher.final(),
    ]);

    // Format: iv:encrypted (both in hex)
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (error) {
    throw new Error('API key encryption failed');
  }
}

/**
 * Decrypts an API key from the database
 * @param encryptedKey - The encrypted key in format "iv:encryptedData"
 * @returns Decrypted plaintext API key
 */
export function decryptApiKey(encryptedKey: string): string {
  try {
    const parts = encryptedKey.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error('Invalid encrypted key format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = Buffer.from(parts[1], 'hex');

    const key = crypto
      .createHash('sha256')
      .update(env.WHATSAPP_SESSION_SECRET)
      .digest();

    const decipher = crypto.createDecipheriv(API_KEY_ALGORITHM, key, iv);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error('API key decryption failed');
  }
}
