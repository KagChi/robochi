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
	info: (message: string, meta?: object) => pinoLogger.info(meta ?? {}, message),
	error: (message: string, meta?: object) => pinoLogger.error(meta ?? {}, message),
	warn: (message: string, meta?: object) => pinoLogger.warn(meta ?? {}, message)
};
