# Stage 1: Builder - Build standalone executable from source
FROM oven/bun:latest AS builder

# Install system dependencies
RUN apt-get update && \
	apt-get install -y git ca-certificates && \
	rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfile and package.json files first for caching
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY apps/worker/package.json ./apps/worker/

# Install all dependencies (skip scripts - lefthook needs .git)
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source code
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY biome.json tsconfig.json ./

# Build standalone executable (bundles everything including Bun runtime)
RUN bun run build

# Verify executable was created
RUN ls -la apps/worker/dist/robochi-worker

# Stage 2: Production - Only the standalone binary
FROM debian:bookworm-slim

# Install base dependencies
RUN apt-get update && \
	apt-get install -y --no-install-recommends \
		git \
		ca-certificates \
		curl \
		wget \
		unzip \
		build-essential && \
	rm -rf /var/lib/apt/lists/*

# Install Bun runtime
RUN curl -fsSL https://bun.sh/install | bash && \
	ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Install Go 1.26.5 (latest stable)
RUN wget https://go.dev/dl/go1.26.5.linux-arm64.tar.gz && \
	tar -C /usr/local -xzf go1.26.5.linux-arm64.tar.gz && \
	rm go1.26.5.linux-arm64.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"

# Install Jabba (Java version manager) and JDK 25
RUN curl -sL https://github.com/Jabba-Team/jabba/raw/main/install.sh | \
	JABBA_COMMAND="install zulu@1.25 -o /usr/local/jdk-25" bash
ENV JAVA_HOME="/usr/local/jdk-25"
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Configure git for runtime worktree commits
RUN git config --global user.email "robochi@example.com" && \
	git config --global user.name "Robochi Bot"

WORKDIR /app

# Copy only the standalone executable
COPY --from=builder /app/apps/worker/dist/robochi-worker ./robochi-worker
RUN chmod +x ./robochi-worker

# Copy entrypoint script that clones repo at runtime if missing
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["/app/robochi-worker"]
