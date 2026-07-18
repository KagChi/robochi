import { logger } from "@kagchi/robochi-core";
import { Octokit } from "octokit";

type OctokitIssue = Awaited<ReturnType<Octokit["rest"]["issues"]["listForRepo"]>>["data"][number];

export type GitHubIssue = OctokitIssue;

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
}
