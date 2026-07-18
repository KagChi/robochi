import { logger } from "@kagchi/robochi-core";
import { Octokit } from "octokit";

type OctokitIssue = Awaited<ReturnType<Octokit["rest"]["issues"]["listForRepo"]>>["data"][number];
type OctokitComment = Awaited<ReturnType<Octokit["rest"]["issues"]["listComments"]>>["data"][number];
type OctokitUser = Awaited<ReturnType<Octokit["rest"]["users"]["getAuthenticated"]>>["data"];
type OctokitPullRequest = Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>["data"];

export type GitHubIssue = OctokitIssue;
export type GitHubComment = OctokitComment;
export type GitHubUser = OctokitUser;
export type GitHubPullRequest = OctokitPullRequest;
export interface RepoContext {
	name: string;
	description: string;
	language: string | null;
	defaultBranch: string;
	tree: string[];
	readme: string | null;
}

export class GitHubClient {
	private octokit: Octokit;
	private owner: string;
	private repo: string;

	constructor(token: string, repository: string) {
		this.octokit = new Octokit({ auth: token });
		const [owner, repo] = repository.split("/");
		if (!owner || !repo) {
			throw new Error(`Invalid repository format: "${repository}". Expected format: owner/repo`);
		}
		this.owner = owner;
		this.repo = repo;
	}

	async fetchIssues(): Promise<GitHubIssue[]> {
		try {
			const { data } = await this.octokit.rest.issues.listForRepo({
				owner: this.owner,
				repo: this.repo,
				state: "all",
				per_page: 100
			});

			return data;
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to fetch issues: ${error.message}`);
			}
			throw error;
		}
	}

	async fetchIssue(issueNumber: number): Promise<GitHubIssue> {
		try {
			const { data } = await this.octokit.rest.issues.get({
				owner: this.owner,
				repo: this.repo,
				issue_number: issueNumber
			});

			return data;
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to fetch issue #${issueNumber}: ${error.message}`);
			}
			throw error;
		}
	}

	async getAuthenticatedUser(): Promise<GitHubUser> {
		try {
			const { data } = await this.octokit.rest.users.getAuthenticated();
			return data;
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to fetch authenticated user: ${error.message}`);
			}
			throw error;
		}
	}

	async fetchIssueComments(issueNumber: number): Promise<GitHubComment[]> {
		try {
			const { data } = await this.octokit.rest.issues.listComments({
				owner: this.owner,
				repo: this.repo,
				issue_number: issueNumber,
				per_page: 100
			});

			return data;
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to fetch comments for issue #${issueNumber}: ${error.message}`);
			}
			throw error;
		}
	}

	async createPullRequest(head: string, base: string, title: string, body: string): Promise<GitHubPullRequest> {
		try {
			const { data } = await this.octokit.rest.pulls.create({
				owner: this.owner,
				repo: this.repo,
				head,
				base,
				title,
				body
			});

			return data;
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to create pull request: ${error.message}`);
			}
			throw error;
		}
	}

	async getPullRequestStatus(pullNumber: number): Promise<"open" | "closed" | "merged"> {
		try {
			const { data } = await this.octokit.rest.pulls.get({
				owner: this.owner,
				repo: this.repo,
				pull_number: pullNumber
			});

			if (data.merged) {
				return "merged";
			}

			return data.state as "open" | "closed";
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to get pull request status for PR #${pullNumber}: ${error.message}`);
			}
			throw error;
		}
	}

	async createIssueComment(issueNumber: number, body: string): Promise<GitHubComment> {
		try {
			const { data } = await this.octokit.rest.issues.createComment({
				owner: this.owner,
				repo: this.repo,
				issue_number: issueNumber,
				body
			});

			return data;
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to create comment on issue #${issueNumber}: ${error.message}`);
			}
			throw error;
		}
	}

	async getRepoFileContent(path: string): Promise<string | null> {
		try {
			const { data } = await this.octokit.rest.repos.getContent({
				owner: this.owner,
				repo: this.repo,
				path
			});

			if (!("content" in data) || data.type !== "file") {
				return null;
			}

			return Buffer.from(data.content, "base64").toString("utf8");
		} catch (error) {
			const status = (error as { status?: number }).status;
			if (status === 404) {
				return null;
			}
			if (error instanceof Error) {
				logger.error(`Failed to fetch file ${path}: ${error.message}`);
			}
			return null;
		}
	}

	async getRepoTree(): Promise<string[]> {
		try {
			const { data } = await this.octokit.rest.repos.getContent({
				owner: this.owner,
				repo: this.repo,
				path: ""
			});

			if (!Array.isArray(data)) {
				return [];
			}

			return data.map((item) => `${item.name} (${item.type})`);
		} catch (error) {
			if (error instanceof Error) {
				logger.warn(`Repository tree unavailable: ${error.message}`);
			}
			return [];
		}
	}

	async getRepoInfo(): Promise<{ name: string; description: string; language: string | null; defaultBranch: string }> {
		try {
			const { data } = await this.octokit.rest.repos.get({
				owner: this.owner,
				repo: this.repo
			});

			return {
				name: data.full_name,
				description: data.description || "",
				language: data.language,
				defaultBranch: data.default_branch
			};
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to fetch repo info: ${error.message}`);
			}
			return { name: `${this.owner}/${this.repo}`, description: "", language: null, defaultBranch: "main" };
		}
	}

	async buildRepoContext(): Promise<RepoContext> {
		const [info, tree, readme] = await Promise.all([this.getRepoInfo(), this.getRepoTree(), this.getRepoFileContent("README.md").then((r) => r || this.getRepoFileContent("readme.md"))]);

		return {
			name: info.name,
			description: info.description,
			language: info.language,
			defaultBranch: info.defaultBranch,
			tree,
			readme
		};
	}
}
