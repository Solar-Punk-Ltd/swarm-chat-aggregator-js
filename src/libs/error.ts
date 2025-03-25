import { Logger } from './logger';

export class ErrorHandler {
  private logger = Logger.getInstance();

  constructor() {}

  handleError(error: unknown, context?: string): void {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const stackTrace = error instanceof Error ? error.stack : null;

    this.logger.error(`Error in ${context || 'unknown context'}: ${errorMessage}`, {
      stack: stackTrace,
    });
  }
}
