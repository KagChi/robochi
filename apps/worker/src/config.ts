/**
 * Configuration loader with zod schema validation
 */
import { z } from "zod";

const configSchema = z.object({
	ghToken: z.string().min(1, "GH_TOKEN is required"),
	ghRepo: z
		.string()
		.min(1, "GH_REPO is required")
		.regex(/^[^/]+\/[^/]+$/, "GH_REPO must be in format: owner/repo"),
	pollInterval: z.number().int().positive().default(30000)
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
	const rawConfig = {
		ghToken: process.env.GH_TOKEN,
		ghRepo: process.env.GH_REPO,
		pollInterval: process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL, 10) : 30000
	};

	return configSchema.parse(rawConfig);
}
