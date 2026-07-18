/**
 * @kagchi/robochi-core
 * Core functionality for the Robochi project
 */

import pino from "pino";

export const VERSION = "0.0.0";

/**
 * Simple greeting function
 */
export function greet(name: string): string {
	return `Hello, ${name}!`;
}

/**
 * Core logger utility with Pino
 */
const pinoLogger = pino({
	transport: {
		target: "pino-pretty",
		options: {
			colorize: true,
			translateTime: "HH:MM:ss.l",
			ignore: "pid,hostname"
		}
	}
});

export const logger = {
	info: (message: string) => pinoLogger.info(message),
	error: (message: string) => pinoLogger.error(message),
	warn: (message: string) => pinoLogger.warn(message)
};
