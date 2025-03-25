/**
 * Pauses the execution of an asynchronous function for a specified duration.
 * @param delay - The delay duration in milliseconds.
 * @returns A promise that resolves after the specified delay.
 */
export function sleep(delay: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}
