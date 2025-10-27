import { GsocSubscription } from '@ethersphere/bee-js';
import * as http from 'http';

import 'dotenv/config';

import { ErrorHandler } from './libs/error.js';
import { Logger } from './libs/logger.js';
import { SwarmAggregator } from './libs/SwarmAggregator.js';

async function main() {
  const errorHandler = ErrorHandler.getInstance();
  const logger = Logger.getInstance();

  const aggregator = new SwarmAggregator();
  let gsocSubscription: GsocSubscription | null = null;
  let server: http.Server | null = null;
  let isShuttingDown = false;

  logger.info('[SwarmAggregator] Starting');

  const port = parseInt(process.env.PORT || '3000', 10);

  server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      if (req.url === '/health' && req.method === 'GET') {
        if (isShuttingDown) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Service Unavailable - Shutting Down');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (error) {
      errorHandler.handleError(error, 'HttpServer');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  });

  server.listen(port, () => {
    logger.info(`[HttpServer] Health check server listening on port ${port}`);
  });

  try {
    await aggregator.initialize();

    gsocSubscription = aggregator.subscribeToGsoc();
    aggregator.startTopicCleaner();
    logger.info('[SwarmAggregator] Started');
  } catch (error) {
    errorHandler.handleError(error, 'main');
    await shutdown();
    process.exit(1);
  }

  async function shutdown() {
    if (isShuttingDown) {
      logger.warn('Shutdown already in progress...');
      return;
    }

    isShuttingDown = true;
    logger.info('\n[SwarmAggregator] Shutting down gracefully...');

    try {
      // Stop accepting new connections
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => {
            logger.info('[HttpServer] Closed');
            resolve();
          });
        });
      }

      if (gsocSubscription) {
        gsocSubscription.cancel();
        logger.info('[GSOC] Subscription cancelled');
      }

      await aggregator.cleanup();
      logger.info('[SwarmAggregator] Cleaned up');

      logger.info('Graceful shutdown completed');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }

  process.on('SIGINT', async () => {
    logger.info('\nReceived SIGINT');
    await shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('\nReceived SIGTERM');
    await shutdown();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    errorHandler.handleError(err, 'UncaughtException');
    shutdown().finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    errorHandler.handleError(reason, 'UnhandledRejection');
    shutdown().finally(() => process.exit(1));
  });
}

main();
