import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';
import { encryptApiKey } from '../utils/encryption.js';

const prisma = new PrismaClient();

async function encryptExistingKeys() {
  logger.info('Starting API key encryption migration...');

  try {
    const providers = await prisma.aIProvider.findMany();

    if (providers.length === 0) {
      logger.info('No AI providers found in database');
      return;
    }

    logger.info({ count: providers.length }, 'Found AI providers to process');

    let encrypted = 0;
    let skipped = 0;
    let failed = 0;

    for (const provider of providers) {
      try {
        // Check if already encrypted (contains colon separator)
        if (provider.apiKey.includes(':')) {
          logger.info(
            { providerId: provider.id, type: provider.type },
            'Key already encrypted, skipping'
          );
          skipped++;
          continue;
        }

        // Encrypt the key
        const encryptedKey = encryptApiKey(provider.apiKey);

        await prisma.aIProvider.update({
          where: { id: provider.id },
          data: { apiKey: encryptedKey },
        });

        logger.info(
          { providerId: provider.id, type: provider.type },
          'Key encrypted successfully'
        );
        encrypted++;
      } catch (error) {
        logger.error(
          { error, providerId: provider.id, type: provider.type },
          'Failed to encrypt key'
        );
        failed++;
      }
    }

    logger.info(
      { total: providers.length, encrypted, skipped, failed },
      'API key encryption migration complete'
    );

    if (failed > 0) {
      logger.warn(
        { failed },
        'Some keys failed to encrypt. Review errors above.'
      );
      process.exit(1);
    }
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

encryptExistingKeys()
  .then(() => {
    logger.info('Migration completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    logger.error({ error }, 'Unexpected error during migration');
    process.exit(1);
  });
