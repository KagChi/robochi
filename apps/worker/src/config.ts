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
	pollInterval: z.number().int().positive().default(30000),
	aiApiBaseUrl: z.string().url("AI_API_BASE_URL must be a valid URL"),
	aiApiKey: z.string().min(1, "AI_API_KEY is required"),
	aiModel: z.string().min(1, "AI_MODEL is required"),
	worktreeBasePath: z.string().min(1, "WORKTREE_BASE_PATH is required"),
	repoPath: z.string().min(1, "REPO_PATH is required").default("./repo"),
	dbPath: z.string().min(1, "DB_PATH is required").default("./data/robochi.db")
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
	const rawConfig = {
		ghToken: process.env.GH_TOKEN,
		ghRepo: process.env.GH_REPO,
		pollInterval: process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL, 10) : 30000,
		aiApiBaseUrl: process.env.AI_API_BASE_URL,
		aiApiKey: process.env.AI_API_KEY,
		aiModel: process.env.AI_MODEL,
		worktreeBasePath: process.env.WORKTREE_BASE_PATH,
		repoPath: process.env.REPO_PATH || "./repo",
		dbPath: process.env.DB_PATH || "./data/robochi.db"
	};

	return configSchema.parse(rawConfig);
}
