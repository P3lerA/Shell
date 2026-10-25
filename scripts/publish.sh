#!/bin/bash
# Copy the published half of the Obsidian vault into this repo and push it;
# Vercel builds on the push. Meant to be the Lobby button on the always-on Mac,
# but it runs anywhere the vault is checked out.
#
#   ./scripts/publish.sh              # vault at ~/Documents/SoD
#   VAULT=/path/to/SoD ./scripts/publish.sh
#
# Archive/ (the wiki, formerly Ragriff/), BlogPosts/ and Story/ are copied by
# name -- a whitelist, not a .gitignore blacklist, so nothing private
# (_miscellaneous, _scripts, .obsidian) can reach a public repo because a rule
# was forgotten. Images are the one exception: those the published notes embed
# are looked up by file name anywhere in the vault (e.g. _image/attachment/)
# and copied into SoD/Attachments/ -- only the referenced ones.
set -euo pipefail

VAULT=${VAULT:-$HOME/Documents/SoD}
REPO=$(cd "$(dirname "$0")/.." && pwd)

WIKI=Archive
[ -d "$VAULT/$WIKI" ] || WIKI=Ragriff
[ -d "$VAULT/$WIKI" ] || { echo "no vault at $VAULT"; exit 1; }

cd "$REPO"
git pull --rebase -q

[ -d SoD/Ragriff ] && git rm -rq SoD/Ragriff
mkdir -p SoD/Archive
rsync -a --delete --exclude '.*' --exclude '_*' "$VAULT/$WIKI/" "SoD/Archive/"
for dir in BlogPosts Story; do
  mkdir -p "SoD/$dir"
  rsync -a --delete --exclude '.*' --exclude '_*' "$VAULT/$dir/" "SoD/$dir/"
done

# Embedded images: ![[name.png]] / ![[dir/name.png|alt]] and ![alt](dir/name.png).
rm -rf SoD/Attachments
mkdir -p SoD/Attachments
{
  grep -rhoE '!\[\[[^]|#]+' --include='*.md' SoD/Archive SoD/BlogPosts SoD/Story | sed 's/^!\[\[//' || true
  grep -rhoE '!\[[^]]*\]\([^)[:space:]]+\)' --include='*.md' SoD/Archive SoD/BlogPosts SoD/Story \
    | sed -E 's/^!\[[^]]*\]\(<?([^)>]+)>?\)$/\1/' | grep -vE '^(https?:|data:|/)' || true
} | sed 's|.*/||' | sort -u | while IFS= read -r name; do
  case "$(printf %s "$name" | tr '[:upper:]' '[:lower:]')" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.svg|*.avif) ;;
    *) continue ;;
  esac
  name=$(printf '%b' "${name//%/\\x}")           # undo %20 etc. in markdown links
  src=$(find "$VAULT" -path "$VAULT/.obsidian" -prune -o -type f -name "$name" -print -quit)
  [ -n "$src" ] || { echo "  ! embedded image not in vault: $name"; continue; }
  case "$src" in "$VAULT/$WIKI/"*|"$VAULT/BlogPosts/"*|"$VAULT/Story/"*) continue ;; esac   # published already
  cp "$src" "SoD/Attachments/$name"
done
rmdir SoD/Attachments 2>/dev/null || true

git add -A SoD
if git diff --cached --quiet; then
  echo "vault unchanged, nothing to publish"
  exit 0
fi

git commit -q -m "vault: $(date -u '+%Y-%m-%d %H:%M') UTC"
git push -q
echo "pushed $(git rev-parse --short HEAD) -- Vercel takes it from here"
