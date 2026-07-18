import { Database } from "bun:sqlite";
import { logger } from "./index";

export interface ProcessedComment {
	comment_id: number;
	issue_number: number;
	processed_at: number;
	mentioned_by: string;
}

export interface Worktree {
	worktree_id: number;
	comment_id: number | null;
	issue_number: number;
	issue_title: string | null;
	branch_name: string;
	directory_path: string;
	status: "active" | "completed" | "failed";
	created_at: number;
	completed_at: number | null;
	pr_url: string | null;
	retry_count: number;
	last_retry_at: number | null;
	plan: string | null;
	implementation_commands: string | null;
	verify_commands: string | null;
	last_error: string | null;
}

export interface ProcessingLog {
	log_id: number;
	worktree_id: number;
	phase: string;
	status: string;
	message: string;
	created_at: number;
}

export class DatabaseService {
	private db: Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath, { create: true });
		this.initialize();
	}

	private initialize(): void {
		// Enable WAL mode for better concurrent performance
		this.db.run("PRAGMA journal_mode = WAL;");

		// Create tables
		this.db.run(`
			CREATE TABLE IF NOT EXISTS processed_comments (
				comment_id INTEGER PRIMARY KEY,
				issue_number INTEGER NOT NULL,
				processed_at INTEGER NOT NULL,
				mentioned_by TEXT NOT NULL
			);
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS worktrees (
				worktree_id INTEGER PRIMARY KEY AUTOINCREMENT,
				comment_id INTEGER,
				issue_number INTEGER NOT NULL,
				issue_title TEXT,
				branch_name TEXT NOT NULL,
				directory_path TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed')),
				created_at INTEGER NOT NULL,
				completed_at INTEGER,
				pr_url TEXT,
				retry_count INTEGER NOT NULL DEFAULT 0,
				last_retry_at INTEGER,
				plan TEXT,
				implementation_commands TEXT,
				verify_commands TEXT,
				last_error TEXT
			);
		`);

		this.migrateWorktreesTable();

		this.db.run(`
			CREATE TABLE IF NOT EXISTS processing_logs (
				log_id INTEGER PRIMARY KEY AUTOINCREMENT,
				worktree_id INTEGER NOT NULL,
				phase TEXT NOT NULL,
				status TEXT NOT NULL,
				message TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (worktree_id) REFERENCES worktrees(worktree_id)
			);
		`);

		// Create indexes for performance
		this.db.run("CREATE INDEX IF NOT EXISTS idx_processed_comments_issue ON processed_comments(issue_number);");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_worktrees_issue ON worktrees(issue_number);");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_processing_logs_worktree ON processing_logs(worktree_id);");

		logger.info("Database initialized successfully");
	}

	private migrateWorktreesTable(): void {
		const columns = new Set((this.db.prepare("PRAGMA table_info(worktrees)").all() as Array<{ name: string }>).map((column) => column.name));
		const migrations: Array<[string, string]> = [
			["comment_id", "ALTER TABLE worktrees ADD COLUMN comment_id INTEGER"],
			["issue_title", "ALTER TABLE worktrees ADD COLUMN issue_title TEXT"],
			["plan", "ALTER TABLE worktrees ADD COLUMN plan TEXT"],
			["implementation_commands", "ALTER TABLE worktrees ADD COLUMN implementation_commands TEXT"],
			["verify_commands", "ALTER TABLE worktrees ADD COLUMN verify_commands TEXT"],
			["last_error", "ALTER TABLE worktrees ADD COLUMN last_error TEXT"]
		];

		for (const [column, sql] of migrations) {
			if (!columns.has(column)) {
				this.db.run(sql);
			}
		}
	}

	// Processed Comments Operations
	markCommentProcessed(commentId: number, issueNumber: number, mentionedBy: string): void {
		const stmt = this.db.prepare("INSERT OR IGNORE INTO processed_comments (comment_id, issue_number, processed_at, mentioned_by) VALUES (?, ?, ?, ?)");
		stmt.run(commentId, issueNumber, Date.now(), mentionedBy);
	}

	isCommentProcessed(commentId: number): boolean {
		const stmt = this.db.prepare("SELECT 1 FROM processed_comments WHERE comment_id = ?");
		const result = stmt.get(commentId);
		return result !== null;
	}

	// Worktree Operations
	createWorktree(
		issueNumber: number,
		branchName: string,
		directoryPath: string,
		options?: { commentId?: number; issueTitle?: string; plan?: string; implementationCommands?: string[]; verifyCommands?: string[] }
	): number {
		const stmt = this.db.prepare(
			"INSERT INTO worktrees (comment_id, issue_number, issue_title, branch_name, directory_path, status, created_at, retry_count, plan, implementation_commands, verify_commands) VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?)"
		);
		const result = stmt.run(
			options?.commentId || null,
			issueNumber,
			options?.issueTitle || null,
			branchName,
			directoryPath,
			Date.now(),
			options?.plan || null,
			options?.implementationCommands ? JSON.stringify(options.implementationCommands) : null,
			options?.verifyCommands ? JSON.stringify(options.verifyCommands) : null
		);
		return Number(result.lastInsertRowid);
	}

	updateWorktreeLastError(worktreeId: number, error: string): void {
		const stmt = this.db.prepare("UPDATE worktrees SET last_error = ? WHERE worktree_id = ?");
		stmt.run(error, worktreeId);
	}

	updateWorktreeVerifyCommands(worktreeId: number, verifyCommands: string[]): void {
		const stmt = this.db.prepare("UPDATE worktrees SET verify_commands = ? WHERE worktree_id = ?");
		stmt.run(JSON.stringify(verifyCommands), worktreeId);
	}

	markWorktreeReadyForRetry(worktreeId: number): void {
		const stmt = this.db.prepare("UPDATE worktrees SET last_retry_at = NULL WHERE worktree_id = ?");
		stmt.run(worktreeId);
	}

	updateWorktreeStatus(worktreeId: number, status: "active" | "completed" | "failed", prUrl?: string): void {
		if (status === "completed" || status === "failed") {
			const stmt = this.db.prepare("UPDATE worktrees SET status = ?, completed_at = ?, pr_url = ? WHERE worktree_id = ?");
			stmt.run(status, Date.now(), prUrl || null, worktreeId);
		} else {
			const stmt = this.db.prepare("UPDATE worktrees SET status = ?, completed_at = NULL WHERE worktree_id = ?");
			stmt.run(status, worktreeId);
		}
	}

	incrementWorktreeRetry(worktreeId: number): void {
		const stmt = this.db.prepare("UPDATE worktrees SET retry_count = retry_count + 1, last_retry_at = ? WHERE worktree_id = ?");
		stmt.run(Date.now(), worktreeId);
	}

	getActiveWorktrees(): Worktree[] {
		const stmt = this.db.prepare("SELECT * FROM worktrees WHERE status = 'active'");
		return stmt.all() as Worktree[];
	}

	getActiveWorktreesForRetry(olderThanTimestamp: number): Worktree[] {
		const stmt = this.db.prepare("SELECT * FROM worktrees WHERE status = 'failed' OR (status = 'active' AND (last_retry_at IS NULL OR last_retry_at < ?))");
		return stmt.all(olderThanTimestamp) as Worktree[];
	}

	getCompletedWorktreesWithPR(): Worktree[] {
		const stmt = this.db.prepare("SELECT * FROM worktrees WHERE status = 'completed' AND pr_url IS NOT NULL");
		return stmt.all() as Worktree[];
	}

	getWorktreeById(worktreeId: number): Worktree | null {
		const stmt = this.db.prepare("SELECT * FROM worktrees WHERE worktree_id = ?");
		return (stmt.get(worktreeId) as Worktree) || null;
	}

	getPersistentWorktreeForIssue(issueNumber: number): Worktree | null {
		const stmt = this.db.prepare(
			"SELECT * FROM worktrees WHERE issue_number = ? AND (status IN ('active', 'failed') OR (status = 'completed' AND pr_url IS NOT NULL)) ORDER BY created_at DESC LIMIT 1"
		);
		return (stmt.get(issueNumber) as Worktree) || null;
	}

	getWorktreeByPullRequestNumber(pullRequestNumber: number): Worktree | null {
		const stmt = this.db.prepare("SELECT * FROM worktrees WHERE pr_url LIKE ? ORDER BY created_at DESC LIMIT 1");
		return (stmt.get(`%/pull/${pullRequestNumber}`) as Worktree) || null;
	}

	deleteWorktree(worktreeId: number): void {
		const stmt = this.db.prepare("DELETE FROM worktrees WHERE worktree_id = ?");
		stmt.run(worktreeId);
	}

	// Processing Logs Operations
	logProcessing(worktreeId: number, phase: string, status: string, message: string): void {
		const stmt = this.db.prepare("INSERT INTO processing_logs (worktree_id, phase, status, message, created_at) VALUES (?, ?, ?, ?, ?)");
		stmt.run(worktreeId, phase, status, message, Date.now());
	}

	getProcessingLogs(worktreeId: number): ProcessingLog[] {
		const stmt = this.db.prepare("SELECT * FROM processing_logs WHERE worktree_id = ? ORDER BY created_at ASC");
		return stmt.all(worktreeId) as ProcessingLog[];
	}

	close(): void {
		this.db.close();
		logger.info("Database connection closed");
	}
}
