#!/bin/bash
# Copy the published half of the Obsidian vault into this repo and push it;
# Vercel builds on the push. Meant to be the Lobby button on the always-on Mac,
# but it runs anywhere the vault is checked out.
#
#   ./scripts/publish.sh              # vault at ~/Documents/SoD
#   VAULT=/path/to/SoD ./scripts/publish.sh
#
# Ragriff/ and BlogPosts/ are copied by name -- a whitelist, not a .gitignore
# blacklist, so nothing private (_miscellaneous, _scripts, .obsidian) can reach
# a public repo because a rule was forgotten.
set -euo pipefail

VAULT=${VAULT:-$HOME/Documents/SoD}
REPO=$(cd "$(dirname "$0")/.." && pwd)

[ -d "$VAULT/Ragriff" ] || { echo "no vault at $VAULT"; exit 1; }

cd "$REPO"
git pull --rebase -q

for dir in Ragriff BlogPosts; do
  mkdir -p "SoD/$dir"
  rsync -a --delete --exclude '.*' --exclude '_*' "$VAULT/$dir/" "SoD/$dir/"
done

git add SoD
if git diff --cached --quiet; then
  echo "vault unchanged, nothing to publish"
  exit 0
fi

git commit -q -m "vault: $(date -u '+%Y-%m-%d %H:%M') UTC"
git push -q
echo "pushed $(git rev-parse --short HEAD) -- Vercel takes it from here"
