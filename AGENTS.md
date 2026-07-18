# Agent Instructions for Robochi

## Project Overview

**Robochi** is a GitHub repository monitoring tool built as a Bun monorepo. It continuously polls GitHub repositories to fetch and monitor issues.

### Architecture

- **Monorepo Structure**: Bun workspaces with `apps/*` and `packages/*`
- **apps/worker**: Main service that polls GitHub for issues using Octokit
- **packages/core**: Shared utilities, logger, and common code

### Key Technologies

- **Runtime**: Bun (JavaScript/TypeScript runtime and build tool)
- **Language**: TypeScript 7.0.2 with strict mode
- **GitHub Integration**: Octokit v4.0.2 for API interactions
- **Validation**: Zod v4.4.3 for schema validation
- **Logging**: Pino v10.3.1 with pretty formatting
- **Tooling**: Biome v2.5.4 (linting/formatting), Lefthook v2.1.10 (git hooks)

## Development Setup

### Prerequisites

- Bun runtime installed
- GitHub personal access token (for API access)
- Git with Lefthook hooks installed (`bun run prepare`)

### Environment Configuration

Create a `.env` file in the project root with:

```env
GH_TOKEN=your_github_token
GH_REPO=owner/repository
POLL_INTERVAL=30000
```

### Workspace Commands

From the repository root:

- `bun run build` - Build all packages
- `bun run dev` - Run all packages in dev mode
- `bun run test` - Run tests
- `bun run type-check` - Type-check all packages
- `bun run check` - Run Biome checks (lint + format)
- `bun run check:fix` - Auto-fix Biome issues
- `bun run clean` - Clean build artifacts

## Code Style and Conventions

### Formatting (Biome Configuration)

- **Indentation**: Tabs (width: 2)
- **Line Width**: 200 characters maximum
- **Quotes**: Double quotes for JS/TS, double quotes for JSX
- **Semicolons**: Always required
- **Trailing Commas**: None
- **Arrow Parentheses**: Always use parentheses
- **Line Ending**: LF (Unix-style)

### Linting Rules

- **No unused variables**: Error-level enforcement
- **No unused imports**: Error-level enforcement
- **No parameter reassignment**: Error
- **Use const**: Error (prefer const over let)
- **Use template literals**: Error (prefer template strings over concatenation)
- **Explicit any**: Allowed (noExplicitAny is off)
- **Exhaustive dependencies**: Warning

### TypeScript Standards

- **Target**: ESNext with bundler module resolution
- **Strict Mode**: Enabled
- **No Unused Parameters**: Error
- **Exact Optional Property Types**: Enabled
- **No Unused Locals**: Error

## Git Workflow

### Commit Message Format

**REQUIRED**: All commits must follow [Conventional Commits](https://www.conventionalcommits.org/) format. Lefthook enforces this pre-commit.

**Format**: `<type>(<scope>): <subject>`

**Types**: feat, fix, docs, style, refactor, test, chore

**Examples**:
```
feat(worker): add retry logic for GitHub API calls
fix(core): correct logger timestamp formatting
docs(readme): update installation instructions
refactor(worker): simplify polling logic
```

### Pre-commit Hooks

Lefthook automatically runs on commit:
1. Biome format check and fix
2. Type-checking
3. Commit message validation (conventional commits)

### CI/CD Pipeline

GitHub Actions runs on every push (`.github/workflows/ci.yml`):
1. Install dependencies
2. Lint with Biome
3. Type-check all packages
4. Build all packages
5. Run tests

## GitHub Integration Guidelines

### IMPORTANT: Use `gh` CLI for GitHub Operations

**ALWAYS use the `gh` CLI tool for fetching data from GitHub**, not direct API calls, web fetching, or other methods.

**Examples**:
- Fetch issues: `gh issue list --repo owner/repo`
- View issue details: `gh issue view <number> --repo owner/repo`
- List repositories: `gh repo list owner`
- View repository info: `gh repo view owner/repo`

**Why**: The `gh` CLI provides authenticated, rate-limit-aware, and properly formatted access to GitHub data.

### Worker Service Patterns

The worker service in `apps/worker/src/` follows these patterns:

1. **Configuration**: Load from environment using Zod schemas (`config.ts`)
2. **GitHub Client**: Octokit wrapper in `github.ts`
3. **Polling Loop**: Continuous polling with configurable intervals
4. **Error Handling**: Exponential backoff (5s → 5min max)
5. **Graceful Shutdown**: Handle SIGINT/SIGTERM signals
6. **Logging**: Use Pino logger from `@kagchi/robochi-core`

### Core Package Usage

Import shared utilities from `@kagchi/robochi-core`:

```typescript
import { logger } from "@kagchi/robochi-core";

logger.info("Message");
logger.error({ err }, "Error message");
```

## Verification Workflow

After making changes:

1. **Type-check**: `bun run type-check` (REQUIRED)
2. **Lint**: `bun run check` (auto-fixed by pre-commit hook)
3. **Build**: `bun run build` (ensure no build errors)
4. **Test**: `bun run test` (if tests exist)
5. **Manual Testing**: Run the affected app with `bun run dev`

For worker changes, verify:
- Configuration loading works with test `.env`
- GitHub API calls succeed
- Error handling behaves correctly
- Logging output is properly formatted

## Package-Specific Guidance

### apps/worker

**Purpose**: Poll GitHub repositories for issues and log details

**Key Files**:
- `src/index.ts` - Main entry point with polling loop
- `src/github.ts` - GitHub API client wrapper
- `src/config.ts` - Environment configuration with Zod validation

**Common Tasks**:
- Adding new GitHub data fetching: Extend `github.ts` client
- Changing polling logic: Modify main loop in `index.ts`
- Adding configuration: Update schema in `config.ts`

### packages/core

**Purpose**: Shared utilities and logger

**Key Files**:
- `src/index.ts` - Logger and utilities export

**Common Tasks**:
- Adding shared utilities: Export from `index.ts`
- Modifying logger: Update Pino configuration
- Adding constants: Export from core for reuse

## Dependencies

### Adding Dependencies

Use Bun's workspace protocol for internal dependencies:

```json
{
  "dependencies": {
    "@kagchi/robochi-core": "workspace:*"
  }
}
```

For external dependencies:
```bash
bun add <package>        # Add to current package
bun add -D <package>     # Add as dev dependency
bun add -w <package>     # Add to workspace root
```

### Dependency Philosophy

- **Prefer well-maintained packages** with active communities
- **Use specific versions** for stability (already using exact versions in lockfile)
- **Minimize dependencies** to reduce bundle size and security surface

## Testing Guidelines

When adding tests:

1. Use Bun's built-in test runner (`bun test`)
2. Place test files adjacent to source: `*.test.ts` or `*.spec.ts`
3. Follow AAA pattern: Arrange, Act, Assert
4. Mock external dependencies (GitHub API calls, etc.)

## Security Considerations

- **Never commit `.env` files** (already gitignored)
- **Rotate GitHub tokens regularly**
- **Use read-only tokens** when write access isn't needed
- **Validate all environment configuration** using Zod schemas
- **Log securely**: Never log tokens or sensitive data

## Common Patterns

### Error Handling

```typescript
try {
	// operation
} catch (error) {
	logger.error({ err: error }, "Operation failed");
	// implement retry or recovery logic
}
```

### Configuration Loading

```typescript
import { z } from "zod";

const ConfigSchema = z.object({
	apiKey: z.string().min(1),
	timeout: z.number().default(30000)
});

const config = ConfigSchema.parse({
	apiKey: process.env.API_KEY,
	timeout: Number(process.env.TIMEOUT)
});
```

### Logging

```typescript
import { logger } from "@kagchi/robochi-core";

logger.info("Operation started");
logger.info({ metadata }, "Operation with context");
logger.error({ err }, "Operation failed");
```

## License

This project is licensed under **GNU General Public License v3.0 (GPL-3.0)**. All contributions must be compatible with GPL-3.0.

---

## Quick Reference

**File Structure**:
```
robochi/
├── apps/
│   └── worker/           # GitHub polling service
├── packages/
│   └── core/             # Shared utilities
├── biome.json            # Linting and formatting config
├── lefthook.yml          # Git hooks configuration
├── tsconfig.json         # TypeScript configuration
└── package.json          # Root workspace config
```

**Essential Commands**:
```bash
bun install              # Install all dependencies
bun run check:fix        # Lint and format
bun run type-check       # Verify types
bun run build            # Build all packages
bun run dev              # Run in development mode
```
