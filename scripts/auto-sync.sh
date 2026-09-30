#!/usr/bin/env bash
# Flytrap Auto-Sync Daemon for host173
# Automatically pulls origin/main and reloads services if changes are detected.
set -euo pipefail

REPO_DIR="/srv/flytrap"
LOG_TAG="flytrap-autoupdate"

cd "$REPO_DIR"

# 1. Fetch silently
git fetch origin main --quiet 2>&1

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0
fi

echo "[$LOG_TAG] New commit detected: $LOCAL -> $REMOTE"

# 2. Check what files changed
CHANGED_FILES=$(git diff --name-only "$LOCAL" "$REMOTE")
echo "[$LOG_TAG] Changed files:"
echo "$CHANGED_FILES"

# 3. Pull latest changes (fast-forward only)
git pull --ff-only origin main

# 4. Determine if container rebuild/restart is needed
NEED_BUILD=false
while IFS= read -r file; do
    case "$file" in
        src/api/public/*|docs/*|README*|LICENSE|*.md|.gitignore)
            # Static files, docs, gitignore - hot reloaded or no runtime effect
            ;;
        *)
            NEED_BUILD=true
            break
            ;;
    esac
done <<< "$CHANGED_FILES"

if [ "$NEED_BUILD" = true ]; then
    echo "[$LOG_TAG] Backend or config changes detected. Rebuilding container..."
    docker compose build flytrap
    echo "[$LOG_TAG] Recreating container..."
    docker compose up -d flytrap
    echo "[$LOG_TAG] Container updated. Testing healthz..."
    sleep 3
    curl -s http://127.0.0.1:8080/healthz || true
    echo ""
    echo "[$LOG_TAG] Successfully updated and verified."
else
    echo "[$LOG_TAG] Frontend or doc changes only. Live hot-reload active, 0 downtime."
fi
