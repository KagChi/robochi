/**
 * @kagchi/robochi-core
 * Core functionality for the Robochi project
 */

export const VERSION = "0.0.0";

/**
 * Simple greeting function
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

/**
 * Core logger utility
 */
export const logger = {
  info: (message: string) => console.log(`[INFO] ${message}`),
  error: (message: string) => console.error(`[ERROR] ${message}`),
  warn: (message: string) => console.warn(`[WARN] ${message}`),
};
