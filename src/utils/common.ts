export function sleep(delay: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

export function getShortMessageId(messageId: string): string {
  return messageId.substring(0, 12);
}

export function getEnvVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not defined`);
  }
  return value;
}

export function getBooleanEnvVariable(name: string, defaultValue: boolean = false): boolean {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }

  const normalizedValue = value.toLowerCase().trim();
  return normalizedValue === 'true';
}

export function getOptionalEnvVariable(name: string): string | undefined {
  return process.env[name];
}

export function getEnvVariableWithDefault(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}
