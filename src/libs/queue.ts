import { sleep } from '../common';

import { ErrorHandler } from './error';

type Task = () => void | Promise<void>;

export class Queue {
  private tasks: Task[] = [];
  private isProcessing = false;
  private isWaiting = false;
  private clearWaitTime: number;
  private errorHandler = new ErrorHandler();

  constructor(
    settings: {
      clearWaitTime?: number;
    } = {},
  ) {
    this.clearWaitTime = settings.clearWaitTime || 500;
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.tasks.length > 0) {
      const task = this.tasks.shift();
      if (!task) continue;

      try {
        const result = task();
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        this.errorHandler.handleError(error, 'Queue.processQueue');
      }
    }

    this.isProcessing = false;
  }

  public enqueue(task: Task): void {
    this.tasks.push(task);
    this.processQueue();
  }

  public async waitForProcessing(): Promise<boolean> {
    if (this.isWaiting) return true;

    this.isWaiting = true;

    while (this.isProcessing) {
      await sleep(this.clearWaitTime);
    }

    this.isWaiting = false;
    return false;
  }
}
