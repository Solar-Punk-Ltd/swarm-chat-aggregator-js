export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

function formatMessage(level: string, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] - ${args
    .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
    .join(' ')}`;
}

export const consoleLogger: Logger = {
  info: (...args) => console.info(formatMessage('info', args)),
  warn: (...args) => console.warn(formatMessage('warn', args)),
  error: (...args) => console.error(formatMessage('error', args)),
  debug: (...args) => console.debug(formatMessage('debug', args)),
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
