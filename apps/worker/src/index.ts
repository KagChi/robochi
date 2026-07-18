import { DatabaseService, logger } from "@kagchi/robochi-core";
import { loadConfig } from "./config";
import { GitHubClient } from "./github";
import { AIService } from "./services/ai";
import { cleanupMergedWorktrees, processFollowUp, processIssue, retryActiveWorktrees } from "./services/processor";

let isShuttingDown = false;

async function main() {
	let db: DatabaseService | null = null;

	try {
		const config = loadConfig();
		logger.info("Worker starting...", {
			repo: config.ghRepo,
			pollInterval: config.pollInterval,
			worktreeBasePath: config.worktreeBasePath,
			dbPath: config.dbPath
		});

		// Initialize database
		db = new DatabaseService(config.dbPath);
		logger.info("Database initialized");

		// Initialize services
		const githubClient = new GitHubClient(config.ghToken, config.ghRepo);
		const aiService = new AIService(config.aiApiBaseUrl, config.aiApiKey, config.aiModel);

		// Fetch authenticated user (bot username)
		const authenticatedUser = await githubClient.getAuthenticatedUser();
		const botUsername = authenticatedUser.login;
		logger.info(`Authenticated as @${botUsername}`);

		let backoffDelay = 0;
		const maxBackoff = 300000; // 5 minutes
		const retryInterval = 300000; // 5 minutes for retry check

		let lastRetryCheck = 0;

		while (!isShuttingDown) {
			try {
				// Fetch all issues
				const issues = await githubClient.fetchIssues();
				logger.info(`Fetched ${issues.length} issues from ${config.ghRepo}`);

				// Process each issue's comments
				for (const issue of issues) {
					try {
						const comments = await githubClient.fetchIssueComments(issue.number);

						// Check each comment for bot mention
						for (const comment of comments) {
							const commentId = comment.id;

							// Skip if already processed
							if (await db.isCommentProcessed(commentId)) {
								continue;
							}

							// Check if bot is mentioned
							const commentBody = comment.body || "";
							const mentionPattern = new RegExp(`@${botUsername}\\b`, "i");
							if (!mentionPattern.test(commentBody)) {
								continue;
							}

							logger.info(`Bot mentioned in issue #${issue.number}, comment ${commentId}`, {
								author: comment.user?.login,
								commentUrl: comment.html_url
							});

							// Classify intent
							const intent = await aiService.classifyIntent(issue.title, issue.body || "", commentBody);
							logger.info(`Intent classified as: ${intent}`, { issueNumber: issue.number, commentId });

							// Mark comment as processed
							await db.markCommentProcessed(commentId, issue.number, comment.user?.login || "unknown");

							if (issue.pull_request) {
								const existingPrJob = db.getWorktreeByPullRequestNumber(issue.number);

								if (!existingPrJob) {
									logger.warn(`No persisted job found for PR #${issue.number}`);
									continue;
								}

								if (intent === "work_on_it") {
									logger.info(`Processing PR follow-up for #${issue.number}`);
									await processFollowUp(existingPrJob, issue, commentBody, config, db, githubClient, aiService);
								} else {
									logger.info(`Answering question on PR #${issue.number}`);
									try {
										const repoContext = await githubClient.buildRepoContext();
										const answer = await aiService.answerQuestion(repoContext, issue.title, issue.body || "", commentBody);
										await githubClient.createIssueComment(issue.number, answer);
										logger.info(`Posted answer on PR #${issue.number}`);
									} catch (error) {
										logger.error(`Failed to answer question on PR #${issue.number}`, {
											error: error instanceof Error ? error.message : String(error)
										});
									}
								}

								continue;
							}

							// Only process if intent is to work on it
							if (intent === "work_on_it") {
								const existingJob = db.getPersistentWorktreeForIssue(issue.number);

								if (existingJob) {
									logger.info(`Skipping issue #${issue.number}, persistent job already exists`, {
										worktreeId: existingJob.worktree_id,
										status: existingJob.status,
										prUrl: existingJob.pr_url
									});
									continue;
								}

								logger.info(`Processing issue #${issue.number}`);
								await processIssue(issue, commentId, commentBody, comment.user?.login || "unknown", config, db, githubClient, aiService);
							} else {
								logger.info(`Answering question on issue #${issue.number}`);
								try {
									const repoContext = await githubClient.buildRepoContext();
									const answer = await aiService.answerQuestion(repoContext, issue.title, issue.body || "", commentBody);
									await githubClient.createIssueComment(issue.number, answer);
									logger.info(`Posted answer on issue #${issue.number}`);
								} catch (error) {
									logger.error(`Failed to answer question on issue #${issue.number}`, {
										error: error instanceof Error ? error.message : String(error)
									});
								}
							}
						}
					} catch (error) {
						logger.error(`Error processing issue #${issue.number}`, {
							error: error instanceof Error ? error.message : String(error)
						});
					}
				}

				// Periodic retry and cleanup tasks
				const now = Date.now();
				if (now - lastRetryCheck >= retryInterval) {
					logger.info("Running retry and cleanup tasks");

					try {
						await retryActiveWorktrees(config, db, githubClient);
					} catch (error) {
						logger.error("Error during retry task", {
							error: error instanceof Error ? error.message : String(error)
						});
					}

					try {
						await cleanupMergedWorktrees(db, githubClient, config);
					} catch (error) {
						logger.error("Error during cleanup task", {
							error: error instanceof Error ? error.message : String(error)
						});
					}

					lastRetryCheck = now;
				}

				// Reset backoff on success
				backoffDelay = 0;

				// Wait for poll interval
				await new Promise((resolve) => setTimeout(resolve, config.pollInterval));
			} catch (error) {
				// Exponential backoff on error
				backoffDelay = Math.min(backoffDelay === 0 ? 5000 : backoffDelay * 2, maxBackoff);
				logger.error(`Error in main loop, retrying in ${backoffDelay}ms`, {
					error: error instanceof Error ? error.message : String(error)
				});
				await new Promise((resolve) => setTimeout(resolve, backoffDelay));
			}
		}

		logger.info("Worker stopped");
	} catch (error) {
		logger.error("Fatal error:", {
			error: error instanceof Error ? error.message : String(error)
		});
		process.exit(1);
	} finally {
		// Close database connection
		if (db) {
			db.close();
			logger.info("Database connection closed");
		}
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
