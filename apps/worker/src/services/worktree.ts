import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "@kagchi/robochi-core";

const execAsync = promisify(exec);

export interface WorktreeConfig {
	basePath: string;
	repoPath: string;
}

export class WorktreeService {
	private config: WorktreeConfig;
	private readonly blockedCommandPatterns = [
		/\bgit\s+(config|add|commit|push|reset|clean|checkout|switch|branch|worktree)\b/,
		/\brm\s+-[^&|;]*[rf]/,
		/\bsudo\b/,
		/\b(su|shutdown|reboot|halt|poweroff)\b/,
		/\b(dd|mkfs|mount|umount)\b/,
		/\bdocker\s+(run|exec|compose|build|up|down|restart|rm|rmi|system)\b/,
		/\bkubectl\s+(delete|apply|replace|patch)\b/,
		/[;&|]\s*(rm\s+-|sudo\b|git\s+(config|add|commit|push|reset|clean))/
	];
	private readonly longRunningVerificationPatterns = [/\b(dev|serve|watch|preview)\b/, /\b(start)\b/];

	constructor(config: WorktreeConfig) {
		this.config = config;
	}

	private assertSafeCommand(command: string): void {
		const normalized = command.trim();

		if (!normalized) {
			throw new Error("Refusing to run empty command");
		}

		for (const pattern of this.blockedCommandPatterns) {
			if (pattern.test(normalized)) {
				throw new Error(`Blocked unsafe command: ${command}`);
			}
		}
	}

	private assertFiniteVerificationCommand(command: string): void {
		for (const pattern of this.longRunningVerificationPatterns) {
			if (pattern.test(command)) {
				throw new Error(`Blocked long-running verification command: ${command}`);
			}
		}
	}

	async createWorktree(issueNumber: number, issueTitle: string): Promise<{ directory: string; branchName: string }> {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const slug = issueTitle
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40);
		const branchName = `feat/robochi/${slug}-${timestamp}`;
		const directory = path.join(this.config.basePath, `issue-${issueNumber}-${timestamp}`);

		try {
			// Ensure base path exists
			await fs.mkdir(this.config.basePath, { recursive: true });

			// Check if repo has any commits (HEAD exists)
			try {
				await execAsync("git rev-parse HEAD", { cwd: this.config.repoPath });
			} catch {
				// No commits yet - create initial commit
				logger.warn("Repository has no commits, creating initial commit");
				await execAsync("touch .gitkeep && git add .gitkeep && git commit -m 'chore: initial commit'", { cwd: this.config.repoPath });
			}

			// Create git worktree
			const { stderr } = await execAsync(`git worktree add -b "${branchName}" "${directory}"`, { cwd: this.config.repoPath });

			if (stderr && !stderr.includes("Preparing worktree")) {
				logger.warn(`Git worktree add stderr: ${stderr}`);
			}

			logger.info(`Created worktree for issue #${issueNumber} at ${directory}`);

			return { directory, branchName };
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to create worktree for issue #${issueNumber}: ${error.message}`);
			}
			throw error;
		}
	}

	async executeInWorktree(directory: string, commands: string[]): Promise<void> {
		try {
			for (const command of commands) {
				this.assertSafeCommand(command);
				logger.info(`Executing in worktree: ${command}`);

				const { stdout, stderr } = await execAsync(command, {
					cwd: directory,
					env: { ...process.env }
				});

				if (stdout) {
					logger.info(`Command output: ${stdout.trim()}`);
				}

				if (stderr) {
					logger.warn(`Command stderr: ${stderr.trim()}`);
				}
			}
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to execute commands in worktree: ${error.message}`);
			}
			throw error;
		}
	}

	async verifyWorktree(directory: string, verifyCommands: string[]): Promise<{ success: boolean; errorOutput: string }> {
		if (verifyCommands.length === 0) {
			logger.info("No verification commands provided, skipping verification");
			return { success: true, errorOutput: "" };
		}

		logger.info(`Running ${verifyCommands.length} verification check(s)...`);

		const errorOutputs: string[] = [];

		for (const command of verifyCommands) {
			try {
				this.assertSafeCommand(command);
				this.assertFiniteVerificationCommand(command);
				logger.info(`Running: ${command}`);
				const { stdout, stderr } = await execAsync(command, { cwd: directory, env: { ...process.env }, maxBuffer: 1024 * 1024 * 10 });
				if (stdout) logger.info(`Output: ${stdout.trim().slice(0, 500)}`);
				if (stderr) logger.warn(`Stderr: ${stderr.trim().slice(0, 500)}`);
				logger.info(`Passed: ${command}`);
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				logger.error(`Failed: ${command}\n${errMsg}`);
				errorOutputs.push(`Command: ${command}\nError: ${errMsg}`);
			}
		}

		return {
			success: errorOutputs.length === 0,
			errorOutput: errorOutputs.join("\n\n")
		};
	}

	async commitAndPush(directory: string, branchName: string, issueNumber: number): Promise<void> {
		try {
			// Stage all changes
			await execAsync("git add .", { cwd: directory });

			// Check if there are changes to commit
			const { stdout: statusOutput } = await execAsync("git status --porcelain", { cwd: directory });

			if (!statusOutput.trim()) {
				logger.warn("No changes to commit");
				return;
			}

			// Commit with conventional commit format
			const commitMessage = `feat: implement solution for issue #${issueNumber}`;
			await execAsync(`git commit -m "${commitMessage}"`, { cwd: directory });

			logger.info("Changes committed");

			// Push to remote
			await execAsync(`git push -u origin "${branchName}"`, { cwd: directory });

			logger.info(`Pushed branch ${branchName} to remote`);
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to commit and push: ${error.message}`);
			}
			throw error;
		}
	}

	async cleanupWorktree(directory: string): Promise<void> {
		try {
			// Remove worktree
			await execAsync(`git worktree remove "${directory}" --force`, { cwd: this.config.repoPath });

			logger.info(`Cleaned up worktree at ${directory}`);
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to cleanup worktree at ${directory}: ${error.message}`);
			}
			throw error;
		}
	}
}
