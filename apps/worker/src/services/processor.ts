import { type DatabaseService, logger, type Worktree } from "@kagchi/robochi-core";
import type { Config } from "../config";
import type { GitHubClient, GitHubIssue, RepoContext } from "../github";
import { AIService } from "./ai";
import { WorktreeService } from "./worktree";

const MAX_RETRIES_PER_CYCLE = 3;

export class ProcessorService {
	private db: DatabaseService;
	private github: GitHubClient;
	private ai: AIService;
	private worktree: WorktreeService;
	private repoContext: RepoContext;

	constructor(db: DatabaseService, github: GitHubClient, ai: AIService, worktree: WorktreeService, repoContext: RepoContext) {
		this.db = db;
		this.github = github;
		this.ai = ai;
		this.worktree = worktree;
		this.repoContext = repoContext;
	}

	async processIssue(issue: GitHubIssue, commentId: number, commentText: string, mentionedBy: string): Promise<void> {
		const issueNumber = issue.number;
		const issueTitle = issue.title;
		const issueBody = issue.body || "";

		logger.info(`Processing issue #${issueNumber} from comment ${commentId}`);

		let worktreeId: number | null = null;

		try {
			// Analyze issue with AI
			logger.info(`Starting analysis for issue #${issueNumber}`);

			const analysis = await this.ai.analyzeIssue(this.repoContext, issueTitle, issueBody, commentText);

			logger.info(`Analysis complete for issue #${issueNumber}`);

			// Create worktree
			logger.info(`Creating worktree for issue #${issueNumber}`);

			const { directory, branchName } = await this.worktree.createWorktree(issueNumber, issueTitle);

			worktreeId = await this.db.createWorktree(issueNumber, branchName, directory, {
				commentId,
				issueTitle,
				plan: analysis.plan,
				implementationCommands: analysis.commands,
				verifyCommands: analysis.verifyCommands
			});

			await this.db.logProcessing(worktreeId, "analysis", "completed", `Plan: ${analysis.plan}`);
			logger.info(`Worktree created for issue #${issueNumber}: ${directory}`);

			// Execute implementation commands
			await this.db.logProcessing(worktreeId, "implementation", "started", "Executing implementation commands");

			await this.worktree.executeInWorktree(directory, analysis.commands);

			await this.db.logProcessing(worktreeId, "implementation", "completed", "Implementation commands executed");
			logger.info(`Implementation complete for issue #${issueNumber}`);

			// Verify implementation (with self-healing)
			const verified = await this.retryVerification(worktreeId, directory, analysis.verifyCommands, issueTitle);

			if (!verified) {
				logger.warn(`Issue #${issueNumber} still failing verification, job remains active for next retry`);
				return;
			}

			// Commit and push
			await this.db.logProcessing(worktreeId, "commit", "started", "Committing and pushing changes");

			await this.worktree.commitAndPush(directory, branchName, issueNumber);

			await this.db.logProcessing(worktreeId, "commit", "completed", "Changes committed and pushed");
			logger.info(`Changes committed and pushed for issue #${issueNumber}`);

			// Create pull request
			await this.db.logProcessing(worktreeId, "pr_creation", "started", "Creating pull request");

			const pr = await this.github.createPullRequest(
				branchName,
				"main",
				`Fix: Issue #${issueNumber}`,
				`## Summary\n\nThis PR solves #${issueNumber}: ${issueTitle}\n\nRequested by @${mentionedBy} in comment ${commentId}.\n\n## What changed\n\n${analysis.plan}\n\n## Verification\n\n${analysis.verifyCommands.map((command) => `- \`${command}\``).join("\n")}\n\nCloses #${issueNumber}`
			);

			await this.db.updateWorktreeStatus(worktreeId, "completed", pr.html_url);
			await this.db.logProcessing(worktreeId, "pr_creation", "completed", `Pull request created: ${pr.html_url}`);

			logger.info(`Pull request created for issue #${issueNumber}: ${pr.html_url}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			logger.error(`Failed to process issue #${issueNumber}: ${errorMessage}`);

			if (worktreeId) {
				await this.db.updateWorktreeStatus(worktreeId, "active");
				await this.db.updateWorktreeLastError(worktreeId, errorMessage);
				await this.db.logProcessing(worktreeId, "error", "retrying", errorMessage);
			}

			throw error;
		}
	}

	async processFollowUp(worktree: Worktree, issue: GitHubIssue, commentText: string): Promise<void> {
		logger.info(`Processing follow-up for worktree ${worktree.worktree_id}`);

		await this.db.updateWorktreeStatus(worktree.worktree_id, "active");
		await this.db.logProcessing(worktree.worktree_id, "follow_up", "started", commentText.slice(0, 500));

		try {
			const analysis = await this.ai.analyzeIssue(this.repoContext, worktree.issue_title || issue.title, issue.body || "", commentText);

			await this.db.logProcessing(worktree.worktree_id, "follow_up", "in_progress", `Plan: ${analysis.plan}`);
			await this.worktree.executeInWorktree(worktree.directory_path, analysis.commands);
			await this.db.updateWorktreeVerifyCommands(worktree.worktree_id, analysis.verifyCommands);

			const verified = await this.retryVerification(worktree.worktree_id, worktree.directory_path, analysis.verifyCommands, worktree.issue_title || issue.title);

			if (!verified) {
				await this.db.logProcessing(worktree.worktree_id, "follow_up", "retrying", "Follow-up remains active for next retry");
				return;
			}

			await this.worktree.commitAndPush(worktree.directory_path, worktree.branch_name, worktree.issue_number);
			await this.db.updateWorktreeStatus(worktree.worktree_id, "completed", worktree.pr_url || undefined);
			await this.db.logProcessing(worktree.worktree_id, "follow_up", "completed", "Follow-up changes pushed to existing PR branch");
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			await this.db.updateWorktreeStatus(worktree.worktree_id, "active");
			await this.db.updateWorktreeLastError(worktree.worktree_id, errorMessage);
			await this.db.logProcessing(worktree.worktree_id, "follow_up", "retrying", errorMessage);
			logger.error(`Follow-up failed for worktree ${worktree.worktree_id}: ${errorMessage}`);
		}
	}

	async retryVerification(worktreeId: number, directory: string, verifyCommands: string[], issueTitle: string): Promise<boolean> {
		const worktree = await this.db.getWorktreeById(worktreeId);

		if (!worktree) {
			throw new Error(`Worktree ${worktreeId} not found`);
		}

		let cycleAttempt = 0;
		let currentVerifyCommands = verifyCommands;

		while (cycleAttempt < MAX_RETRIES_PER_CYCLE) {
			await this.db.logProcessing(worktreeId, "verification", "started", `Verification attempt ${cycleAttempt + 1}/${MAX_RETRIES_PER_CYCLE}`);

			const result = await this.worktree.verifyWorktree(directory, currentVerifyCommands);

			if (result.success) {
				await this.db.logProcessing(worktreeId, "verification", "completed", "Verification passed");
				logger.info(`Verification passed for worktree ${worktreeId}`);
				return true;
			}

			cycleAttempt++;
			await this.db.incrementWorktreeRetry(worktreeId);
			await this.db.updateWorktreeLastError(worktreeId, result.errorOutput);
			await this.db.logProcessing(worktreeId, "verification", "failed", `Attempt ${cycleAttempt}/${MAX_RETRIES_PER_CYCLE}: ${result.errorOutput.slice(0, 500)}`);

			logger.warn(`Verification failed for worktree ${worktreeId}, retry ${cycleAttempt}/${MAX_RETRIES_PER_CYCLE}`);

			// Self-heal: ask AI to generate fix commands based on error output
			logger.info(`Self-healing: generating fixes for worktree ${worktreeId}`);
			await this.db.logProcessing(worktreeId, "self_heal", "started", "Generating fixes for verification errors");

			try {
				const fix = await this.ai.fixErrors(this.repoContext, issueTitle, currentVerifyCommands, result.errorOutput, {
					plan: worktree.plan,
					implementationCommands: worktree.implementation_commands
				});

				logger.info(`Applying ${fix.commands.length} fix command(s): ${fix.plan}`);
				await this.db.logProcessing(worktreeId, "self_heal", "in_progress", `Plan: ${fix.plan}`);

				if (fix.verifyCommands && fix.verifyCommands.length > 0) {
					currentVerifyCommands = fix.verifyCommands;
					await this.db.updateWorktreeVerifyCommands(worktreeId, currentVerifyCommands);
					await this.db.logProcessing(worktreeId, "verification", "updated", `Updated verify commands: ${currentVerifyCommands.join(" && ")}`);
				}

				await this.worktree.executeInWorktree(directory, fix.commands);

				await this.db.logProcessing(worktreeId, "self_heal", "completed", "Fix commands applied");
			} catch (healError) {
				const healMsg = healError instanceof Error ? healError.message : String(healError);
				logger.error(`Self-heal failed for worktree ${worktreeId}: ${healMsg}`);
				await this.db.logProcessing(worktreeId, "self_heal", "failed", healMsg);
			}
		}

		await this.db.markWorktreeReadyForRetry(worktreeId);
		await this.db.logProcessing(worktreeId, "verification", "retrying", `Verification still failing after ${MAX_RETRIES_PER_CYCLE} attempts this cycle. Job remains active for next retry.`);
		logger.warn(`Verification still failing for worktree ${worktreeId} after ${MAX_RETRIES_PER_CYCLE} attempts this cycle. Job remains active for next retry.`);
		return false;
	}

	async retryActiveWorktrees(): Promise<void> {
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		const worktrees = await this.db.getActiveWorktreesForRetry(fiveMinutesAgo);

		if (worktrees.length === 0) {
			return;
		}

		logger.info(`Found ${worktrees.length} active worktrees to retry`);

		for (const worktree of worktrees) {
			try {
				logger.info(`Retrying verification for worktree ${worktree.worktree_id}`);
				await this.db.updateWorktreeStatus(worktree.worktree_id, "active");

				const issue = await this.github.fetchIssue(worktree.issue_number);
				let verifyCommands = worktree.verify_commands ? (JSON.parse(worktree.verify_commands) as string[]) : [];

				if (verifyCommands.length === 0) {
					const analysis = await this.ai.analyzeIssue(this.repoContext, issue.title, issue.body || "", "retry verification");
					verifyCommands = analysis.verifyCommands;
				}

				const verified = await this.retryVerification(worktree.worktree_id, worktree.directory_path, verifyCommands, issue.title);

				if (!verified) {
					continue;
				}

				// If verification passes, continue with commit and PR
				await this.db.logProcessing(worktree.worktree_id, "commit", "started", "Committing and pushing changes (retry)");

				await this.worktree.commitAndPush(worktree.directory_path, worktree.branch_name, worktree.issue_number);

				await this.db.logProcessing(worktree.worktree_id, "commit", "completed", "Changes committed and pushed (retry)");

				// Create pull request
				await this.db.logProcessing(worktree.worktree_id, "pr_creation", "started", "Creating pull request (retry)");

				const pr = await this.github.createPullRequest(
					worktree.branch_name,
					"main",
					`Fix: Issue #${worktree.issue_number}`,
					`## Summary\n\nThis PR solves #${worktree.issue_number}: ${worktree.issue_title || issue.title}\n\nRequested from comment ${worktree.comment_id || "unknown"}.\n\n## What changed\n\n${worktree.plan || "(not recorded)"}\n\n## Verification\n\n${verifyCommands.map((command) => `- \`${command}\``).join("\n")}\n\nCloses #${worktree.issue_number}`
				);

				await this.db.updateWorktreeStatus(worktree.worktree_id, "completed", pr.html_url);
				await this.db.logProcessing(worktree.worktree_id, "pr_creation", "completed", `Pull request created: ${pr.html_url}`);

				logger.info(`Retry successful for worktree ${worktree.worktree_id}`);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				logger.error(`Retry failed for worktree ${worktree.worktree_id}: ${errorMessage}`);

				await this.db.updateWorktreeStatus(worktree.worktree_id, "active");
				await this.db.updateWorktreeLastError(worktree.worktree_id, errorMessage);
				await this.db.logProcessing(worktree.worktree_id, "retry", "retrying", errorMessage);
			}
		}
	}

	async cleanupMergedWorktrees(): Promise<void> {
		const completedWorktrees = await this.db.getCompletedWorktreesWithPR();

		if (completedWorktrees.length === 0) {
			return;
		}

		logger.info(`Checking ${completedWorktrees.length} completed worktrees for PR merge status`);

		for (const worktree of completedWorktrees) {
			try {
				// Extract PR number from URL (e.g., https://github.com/owner/repo/pull/123)
				const prMatch = worktree.pr_url?.match(/\/pull\/(\d+)$/);

				if (!prMatch) {
					logger.warn(`Invalid PR URL for worktree ${worktree.worktree_id}: ${worktree.pr_url}`);
					continue;
				}

				const prNumber = Number.parseInt(prMatch[1], 10);
				const prStatus = await this.github.getPullRequestStatus(prNumber);

				if (prStatus === "merged") {
					logger.info(`PR #${prNumber} is merged, cleaning up worktree ${worktree.worktree_id}`);

					await this.worktree.cleanupWorktree(worktree.directory_path);
					await this.db.deleteWorktree(worktree.worktree_id);

					logger.info(`Cleaned up worktree ${worktree.worktree_id}`);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				logger.error(`Failed to cleanup worktree ${worktree.worktree_id}: ${errorMessage}`);
			}
		}
	}
}

// Export standalone functions for main loop
export async function processIssue(
	issue: GitHubIssue,
	commentId: number,
	commentText: string,
	_mentionedBy: string,
	config: Config,
	db: DatabaseService,
	github: GitHubClient,
	ai: AIService
): Promise<void> {
	const repoContext = await github.buildRepoContext();
	const worktree = new WorktreeService({ basePath: config.worktreeBasePath, repoPath: config.repoPath });
	const processor = new ProcessorService(db, github, ai, worktree, repoContext);
	await processor.processIssue(issue, commentId, commentText, _mentionedBy);
}

export async function retryActiveWorktrees(config: Config, db: DatabaseService, github: GitHubClient): Promise<void> {
	const ai = new AIService(config.aiApiBaseUrl, config.aiApiKey, config.aiModel);
	const repoContext = await github.buildRepoContext();
	const worktree = new WorktreeService({ basePath: config.worktreeBasePath, repoPath: config.repoPath });
	const processor = new ProcessorService(db, github, ai, worktree, repoContext);
	await processor.retryActiveWorktrees();
}

export async function processFollowUp(worktreeJob: Worktree, issue: GitHubIssue, commentText: string, config: Config, db: DatabaseService, github: GitHubClient, ai: AIService): Promise<void> {
	const repoContext = await github.buildRepoContext();
	const worktree = new WorktreeService({ basePath: config.worktreeBasePath, repoPath: config.repoPath });
	const processor = new ProcessorService(db, github, ai, worktree, repoContext);
	await processor.processFollowUp(worktreeJob, issue, commentText);
}

export async function cleanupMergedWorktrees(db: DatabaseService, github: GitHubClient, config: Config): Promise<void> {
	const ai = new AIService(config.aiApiBaseUrl, config.aiApiKey, config.aiModel);
	const repoContext = await github.buildRepoContext();
	const worktree = new WorktreeService({ basePath: config.worktreeBasePath, repoPath: config.repoPath });
	const processor = new ProcessorService(db, github, ai, worktree, repoContext);
	await processor.cleanupMergedWorktrees();
}
