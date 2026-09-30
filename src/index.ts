import { existsSync } from 'node:fs';

import { consoleLogger } from './libs/logger.js';
import { AggregatorServer } from './server.js';
import { SettingsError, parseSettings } from './settings.js';

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  let settings;
  try {
    settings = parseSettings(process.env);
  } catch (error) {
    consoleLogger.error(error instanceof SettingsError ? error.message : String(error));
    process.exit(2);
  }

  const server = new AggregatorServer(settings, {
    logger: consoleLogger,
    onFatal: () => process.exit(1),
  });

  const shutdown = (signal: string) => {
    consoleLogger.info(`[server] ${signal} received, draining`);
    server.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        consoleLogger.error('[server] shutdown failed', String(error));
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) =>
    consoleLogger.error('[process] uncaught exception', error.stack ?? error.message),
  );
  process.on('unhandledRejection', (reason) => consoleLogger.error('[process] unhandled rejection', String(reason)));

  try {
    await server.start();
  } catch (error) {
    consoleLogger.error('[server] could not start:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
