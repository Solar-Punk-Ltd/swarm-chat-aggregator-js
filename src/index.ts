import * as http from 'http';

import 'dotenv/config';

import { ErrorHandler } from './libs/error.js';
import { Logger } from './libs/logger.js';
import { SwarmAggregator } from './libs/SwarmAggregator.js';

async function main() {
  const aggregator = new SwarmAggregator();
  const errorHandler = ErrorHandler.getInstance();
  const logger = Logger.getInstance();
  logger.info('[SwarmAggregator] Starting');

  const port = parseInt(process.env.PORT || '3000', 10);
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    logger.info(`[HttpServer] Health check server listening on port ${port}`);
  });

  try {
    aggregator.subscribeToGsoc();
    aggregator.startTopicCleaner();
    logger.info('[SwarmAggregator] Started');
  } catch (error) {
    errorHandler.handleError(error, 'main');
    process.exit(1);
  }

  // Docker stops a container with SIGTERM; without a handler the process is killed after the grace
  // period with the socket still open.
  const shutdown = (signal: string) => {
    logger.info(`\n[SwarmAggregator] ${signal} received, shutting down...`);
    aggregator.unsubscribeFromGsoc();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    errorHandler.handleError(err, 'UncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    errorHandler.handleError(reason, 'UnhandledRejection');
  });
}

main();
