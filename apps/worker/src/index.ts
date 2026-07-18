import { logger } from "@kagchi/robochi-core";
import { loadConfig } from "./config";
import { GitHubClient } from "./github";

let isShuttingDown = false;

async function main() {
	try {
		const config = loadConfig();
		logger.info("Worker starting...", {
			repo: config.ghRepo,
			pollInterval: config.pollInterval
		});

		const githubClient = new GitHubClient(config.ghToken, config.ghRepo);

		let backoffDelay = 0;
		const maxBackoff = 300000; // 5 minutes

		while (!isShuttingDown) {
			try {
				const issues = await githubClient.fetchIssues();
				logger.info(`Fetched ${issues.length} issues from ${config.ghRepo}`);

				for (const issue of issues) {
					logger.info(`Issue #${issue.number}: ${issue.title}`, {
						state: issue.state,
						author: issue.user.login,
						labels: issue.labels.map((l) => l.name),
						created: issue.created_at,
						updated: issue.updated_at,
						url: issue.html_url
					});
				}

				// Reset backoff on success
				backoffDelay = 0;

				// Wait for poll interval
				await new Promise((resolve) => setTimeout(resolve, config.pollInterval));
			} catch (error) {
				// Exponential backoff on error
				backoffDelay = Math.min(backoffDelay === 0 ? 5000 : backoffDelay * 2, maxBackoff);
				logger.error(`Error fetching issues, retrying in ${backoffDelay}ms`, error instanceof Error ? { error: error.message } : {});
				await new Promise((resolve) => setTimeout(resolve, backoffDelay));
			}
		}

		logger.info("Worker stopped");
	} catch (error) {
		logger.error("Fatal error:", error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

// Graceful shutdown
process.on("SIGINT", () => {
	logger.info("Received SIGINT, shutting down gracefully...");
	isShuttingDown = true;
});

process.on("SIGTERM", () => {
	logger.info("Received SIGTERM, shutting down gracefully...");
	isShuttingDown = true;
});

main();
