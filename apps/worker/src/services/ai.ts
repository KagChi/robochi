import { logger } from "@kagchi/robochi-core";
import OpenAI from "openai";
import type { RepoContext } from "../github";

export type IntentClassification = "work_on_it" | "general_question";

export interface AnalysisResult {
	plan: string;
	commands: string[];
	verifyCommands: string[];
}

export interface FixResult {
	plan: string;
	commands: string[];
	verifyCommands?: string[];
}

export class AIService {
	private client: OpenAI;
	private model: string;

	constructor(apiBaseUrl: string, apiKey: string, model: string) {
		this.client = new OpenAI({
			apiKey,
			baseURL: apiBaseUrl
		});
		this.model = model;
	}

	private parseJsonObject<T>(content: string): T {
		const firstBrace = content.indexOf("{");
		const lastBrace = content.lastIndexOf("}");
		const jsonStr = firstBrace !== -1 && lastBrace !== -1 ? content.slice(firstBrace, lastBrace + 1) : content;

		try {
			return JSON.parse(jsonStr) as T;
		} catch (parseError) {
			// Some models emit invalid JSON escapes like \$ or \. inside shell commands.
			const repaired = jsonStr.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
			try {
				return JSON.parse(repaired) as T;
			} catch {
				logger.error(`Failed to parse AI response as JSON. Raw content: ${content}`);
				throw new Error(`Failed to parse JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
			}
		}
	}

	async answerQuestion(repoContext: RepoContext, issueTitle: string, issueBody: string, commentText: string): Promise<string> {
		const systemPrompt = `You are a helpful GitHub bot assistant working on the repository ${repoContext.name}.

Repository context:
- Language: ${repoContext.language || "unknown"}
- Description: ${repoContext.description || "(none)"}
- Default branch: ${repoContext.defaultBranch}
- Root files: ${repoContext.tree.join(", ") || "(empty)"}

${repoContext.readme ? `README (excerpt):\n${repoContext.readme.slice(0, 3000)}` : ""}

Answer the user's question about the issue concisely and accurately.

Be:
- Direct and to the point
- Technical but clear
- Markdown formatted when helpful
- Specific to THIS repository's stack and conventions

Do not offer to implement the solution unless explicitly asked.`;

		const userPrompt = `Issue Title: ${issueTitle}

Issue Body:
${issueBody}

User Question:
${commentText}

Answer:`;

		try {
			const completion = await this.client.chat.completions.create({
				model: this.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt }
				],
				temperature: 0.5,
				max_tokens: 1000
			});

			const content = completion.choices?.[0]?.message?.content?.trim();

			if (!content) {
				throw new Error("Empty response from AI API");
			}

			return content;
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to answer question: ${error.message}`);
			}
			throw error;
		}
	}

	async classifyIntent(issueTitle: string, issueBody: string, commentText: string): Promise<IntentClassification> {
		const systemPrompt = `You are a GitHub bot assistant that classifies user intent from issue comments.

Your task is to determine if a comment is asking you to work on the issue (implement/fix/develop) or just asking a general question.

Classification rules:
- "work_on_it": User explicitly asks you to implement, fix, develop, work on, or solve the issue
- "general_question": User is asking for information, clarification, help, or general discussion

Examples of "work_on_it":
- "can you work on this?"
- "please fix this bug"
- "implement this feature"
- "@bot solve this issue"
- "can you help with this implementation?"

Examples of "general_question":
- "what do you think about this?"
- "how should we approach this?"
- "can you explain this error?"
- "is this the right approach?"
- "@bot what's your opinion?"

Respond with ONLY "work_on_it" or "general_question", nothing else.`;

		const userPrompt = `Issue Title: ${issueTitle}

Issue Body:
${issueBody}

Comment:
${commentText}

Classification:`;

		try {
			const completion = await this.client.chat.completions.create({
				model: this.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt }
				],
				temperature: 0.3,
				max_tokens: 10
			});

			const classification = completion.choices?.[0]?.message?.content?.trim().toLowerCase();

			if (classification === "work_on_it" || classification === "general_question") {
				return classification;
			}

			logger.warn(`Unexpected AI classification response: ${classification}, defaulting to general_question`);
			return "general_question";
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to classify intent: ${error.message}`);
			}
			throw error;
		}
	}

	async analyzeIssue(repoContext: RepoContext, issueTitle: string, issueBody: string, commentText: string): Promise<AnalysisResult> {
		const systemPrompt = `You are a GitHub bot assistant that analyzes issues and creates implementation plans for the repository ${repoContext.name}.

Your task is to:
1. Understand the issue requirements
2. Create a detailed implementation plan tailored to THIS repository
3. Generate shell commands to implement the solution

Repository context:
- Language: ${repoContext.language || "unknown"}
- Description: ${repoContext.description || "(none)"}
- Default branch: ${repoContext.defaultBranch}
- Root files: ${repoContext.tree.join(", ") || "(empty)"}

${repoContext.readme ? `README (excerpt):\n${repoContext.readme.slice(0, 3000)}` : ""}

IMPORTANT: Infer available build/test/lint commands from the repository's file structure and conventions. Do not assume any specific toolchain. Use whatever commands the repository actually supports based on its language and files (e.g. Makefile, package.json, Cargo.toml, go.mod, pyproject.toml, pom.xml, etc.).

Your response must be valid JSON with this structure:
{
  "plan": "Detailed implementation plan as a string",
  "commands": ["command1", "command2", "command3"],
  "verifyCommands": ["command1", "command2"]
}

- commands: shell commands to implement the solution (be specific and complete). Each command must be a single shell command. Do NOT use heredocs (cat << EOF). Instead, use echo with -e or printf, or write files via separate script invocations. All newlines inside JSON strings must be escaped as \\n. NEVER include git commands for config/add/commit/push/reset/clean/checkout/switch/branch/worktree - git operations are handled automatically. NEVER include destructive commands such as rm -rf, sudo, su, dd, mkfs, shutdown, reboot, docker lifecycle commands, or kubectl mutation commands.
- verifyCommands: finite, non-interactive shell commands to verify the implementation works (e.g. run tests, type-check, build, lint - whatever this repository supports). NEVER use dev/watch/server commands such as dev, start, serve, watch, preview, or any command that keeps running.

Respond with ONLY the JSON, no markdown, no code fences. Ensure all string values are properly JSON-escaped.`;

		const userPrompt = `Issue Title: ${issueTitle}

Issue Body:
${issueBody}

User Request:
${commentText}

Analyze this issue and provide an implementation plan with commands:`;

		try {
			const completion = await this.client.chat.completions.create({
				model: this.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt }
				],
				temperature: 0.7,
				max_tokens: 4000
			});

			const content = completion.choices?.[0]?.message?.content?.trim();

			if (!content) {
				throw new Error("Empty response from AI API");
			}

			const result = this.parseJsonObject<AnalysisResult>(content);

			if (!result.plan || !Array.isArray(result.commands) || !Array.isArray(result.verifyCommands)) {
				throw new Error("Invalid analysis result structure");
			}

			return result;
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to analyze issue: ${error.message}`);
			}
			throw error;
		}
	}

	async fixErrors(
		repoContext: RepoContext,
		issueTitle: string,
		verifyCommands: string[],
		errorOutput: string,
		jobContext?: { plan: string | null; implementationCommands: string | null }
	): Promise<FixResult> {
		const systemPrompt = `You are a self-healing code fixer bot for repository ${repoContext.name}.

A previous implementation failed verification. Your job is to analyze the failure and produce fix commands that resolve the errors.

Repository context:
- Language: ${repoContext.language || "unknown"}
- Description: ${repoContext.description || "(none)"}
- Default branch: ${repoContext.defaultBranch}
- Root files: ${repoContext.tree.join(", ") || "(empty)"}

${repoContext.readme ? `README (excerpt):\n${repoContext.readme.slice(0, 2000)}` : ""}

Current job context:
- Issue title: ${issueTitle}
- Original implementation plan: ${jobContext?.plan || "(unknown)"}
- Commands already applied: ${jobContext?.implementationCommands || "(unknown)"}

Your response must be valid JSON with this structure:
{
  "plan": "Brief explanation of what was wrong and how you will fix it",
  "commands": ["fix command 1", "fix command 2"],
  "verifyCommands": ["finite verification command 1", "finite verification command 2"]
}

Rules:
- Each command must be a single shell command. No heredocs (cat << EOF). Use echo -e or printf instead. Escape newlines in JSON as \\n.
- NEVER include git commands for config/add/commit/push/reset/clean/checkout/switch/branch/worktree - handled automatically.
- NEVER include destructive commands such as rm -rf, sudo, su, dd, mkfs, shutdown, reboot, docker lifecycle commands, or kubectl mutation commands.
- Infer the right toolchain from repo files (Makefile, package.json, Cargo.toml, go.mod, pyproject.toml, pom.xml, etc.).
- Focus on fixing the specific errors shown. Be surgical.
- Do not assume any runtime, language, package manager, linter, formatter, or test framework. Infer them only from repository context, failed commands, and error output.
- If the error comes from a linter, formatter, parser, compiler, type-checker, or test runner, prefer the repository's own safe fixer command when one exists. If no fixer exists, edit the smallest affected files directly.
- Verification commands must be finite and non-interactive. Do not run dev/watch/server commands.
- Treat the failing command list and error output below as primary context for the next fix. Address the concrete diagnostics shown before attempting unrelated cleanup.
- If any previous verification command is invalid, unavailable, long-running, or wrong for this repository, return a corrected verifyCommands list.
- If previous verification commands are still good, return the same verifyCommands list.

Respond with ONLY the JSON, no markdown, no code fences.`;

		const userPrompt = `Issue Title: ${issueTitle}

Original implementation plan:
${jobContext?.plan || "(unknown)"}

Commands already applied:
${jobContext?.implementationCommands || "(unknown)"}

Verification commands that failed:
${verifyCommands.join("\n")}

Error output:
${errorOutput.slice(0, 6000)}

Provide fix commands:`;

		try {
			const completion = await this.client.chat.completions.create({
				model: this.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt }
				],
				temperature: 0.4,
				max_tokens: 4000
			});

			const content = completion.choices?.[0]?.message?.content?.trim();

			if (!content) {
				throw new Error("Empty response from AI API");
			}

			const result = this.parseJsonObject<FixResult>(content);

			if (!result.plan || !Array.isArray(result.commands)) {
				throw new Error("Invalid fix result structure");
			}

			if (result.verifyCommands && !Array.isArray(result.verifyCommands)) {
				throw new Error("Invalid fix verifyCommands structure");
			}

			return result;
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Failed to generate fixes: ${error.message}`);
			}
			throw error;
		}
	}
}
