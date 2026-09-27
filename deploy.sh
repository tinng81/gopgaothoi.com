#!/usr/bin/env bash
# #!zh: 一键导出并部署邀请函：在 luban-h5 仓库构建 site/（自包含静态导出），
#       同步到本仓库并 push，Cloudflare Pages 自动构建上线。
# #!en: One-shot export & deploy: build site/ in the luban-h5 repo
#       (self-contained static export), sync it into this repo and push —
#       Cloudflare Pages builds and goes live automatically.
#
# Usage:
#   ./deploy.sh [workId] [apiBase]        # defaults: 53, http://localhost:1337
#   REBUILD_ENGINE=1 ./deploy.sh          # also rebuild the engine bundle first
#                                         # (only needed after plugin-code changes)
#
# Env overrides:
#   LUBAN_DIR   path to the luban-h5 checkout
#               (default: /Users/winng/Documents/GitHub/luban-h5)
set -euo pipefail

WORK_ID="${1:-53}"
API_BASE="${2:-http://localhost:1337}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
LUBAN_DIR="${LUBAN_DIR:-/Users/winng/Documents/GitHub/luban-h5}"

command -v node >/dev/null || { echo "error: node not found"; exit 1; }
[ -d "$LUBAN_DIR" ] || { echo "error: luban-h5 not found at $LUBAN_DIR (set LUBAN_DIR=...)"; exit 1; }
curl -sf -o /dev/null "$API_BASE/_health" || {
  echo "error: Strapi not reachable at $API_BASE — start the stack first (docker compose up -d in $LUBAN_DIR)"
  exit 1
}

cd "$LUBAN_DIR"
if [ "${REBUILD_ENGINE:-0}" = "1" ]; then
  echo "==> rebuilding engine bundle (docker compose --profile tools run --rm engine-build)"
  docker compose --profile tools run --rm engine-build
fi

echo "==> exporting work $WORK_ID from $API_BASE"
node scripts/build-site.mjs "$WORK_ID" --api-base "$API_BASE" --out site

echo "==> syncing into $DEPLOY_DIR/site/"
rsync -a --delete --exclude .DS_Store "$LUBAN_DIR/site/" "$DEPLOY_DIR/site/"

cd "$DEPLOY_DIR"
if [ -z "$(git status --porcelain)" ]; then
  echo "==> no changes since last deploy — nothing to do"
  exit 0
fi

git add -A
git commit -m "chore: refresh invitation export (work $WORK_ID)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$BRANCH"

echo "==> pushed $BRANCH — Cloudflare Pages is building, live in ~1 min at:"
echo "    https://gopgaothoi.com  ·  https://gopgaothoi-com.pages.dev"
