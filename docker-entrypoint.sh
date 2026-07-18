#!/bin/sh
set -e

REPO_DIR="/app/repo"

if [ -z "$GH_REPO" ]; then
	echo "ERROR: GH_REPO environment variable is required (format: owner/repo)"
	exit 1
fi

if [ ! -d "$REPO_DIR/.git" ]; then
	echo "Cloning repository $GH_REPO..."
	git clone "https://github.com/${GH_REPO}.git" "$REPO_DIR"
else
	echo "Repository already cloned, fetching updates..."
	cd "$REPO_DIR"
	git fetch origin
	git reset --hard origin/HEAD 2>/dev/null || git checkout main 2>/dev/null || git checkout master 2>/dev/null || true
fi

cd "$REPO_DIR"
echo "Repository ready at $REPO_DIR"

# Execute the main command (robochi-worker binary)
exec "$@"
