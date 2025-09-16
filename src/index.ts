import { GsocSubscription } from '@ethersphere/bee-js';
import * as http from 'http';

import 'dotenv/config';

import { ErrorHandler } from './libs/error.js';
import { Logger } from './libs/logger.js';
import { SwarmAggregator } from './libs/SwarmAggregator.js';

async function main() {
  const aggregator = new SwarmAggregator();
  const errorHandler = ErrorHandler.getInstance();
  const logger = Logger.getInstance();
  let gsocSubscription: GsocSubscription;

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
    gsocSubscription = aggregator.subscribeToGsoc();
    aggregator.startTopicCleaner();
    logger.info('[SwarmAggregator] Started');
  } catch (error) {
    errorHandler.handleError(error, 'main');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    logger.info('\n[SwarmAggregator] Shutting down...');
    gsocSubscription.cancel();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    errorHandler.handleError(err, 'UncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    errorHandler.handleError(reason, 'UnhandledRejection');
  });
}

main();
