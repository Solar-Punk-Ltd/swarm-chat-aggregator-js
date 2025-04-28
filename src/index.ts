import { GsocSubscription } from '@ethersphere/bee-js';

import 'dotenv/config';

import { ErrorHandler } from './libs/error';
import { Logger } from './libs/logger';
import { SwarmAggregator } from './libs/SwarmAggregator';

async function main() {
  const aggregator = new SwarmAggregator();
  const errorHandler = new ErrorHandler();
  const logger = Logger.getInstance();
  let gsocSubscription: GsocSubscription;

  logger.info('[SwarmAggregator] Starting');

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
