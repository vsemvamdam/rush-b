#!/usr/bin/env bash
# Publishes <src_dir>/*.json as matches/*.json in the single commit of an orphan branch (default stats-data),
# force-pushed so the git history never grows. Skips the push when the branch already has the same files.
# Runs inside an actions/checkout workspace (reuses its auth header). Usage: scripts/publish-stats-branch.sh <src_dir> [branch]
set -euo pipefail
src="$1"
branch="${2:-stats-data}"
if ! ls "$src"/*.json >/dev/null 2>&1; then echo "матчей пока нет — публиковать нечего"; exit 0; fi
if git fetch -q --depth=1 origin "$branch" 2>/dev/null; then
  same=1
  for f in "$src"/*.json; do
    git show "FETCH_HEAD:matches/$(basename "$f")" > /tmp/remote-stats.json 2>/dev/null && cmp -s /tmp/remote-stats.json "$f" || same=0
  done
  if [ "$same" = 1 ]; then echo "ветка $branch уже актуальна"; exit 0; fi
fi
auth="$(git config --get http.https://github.com/.extraheader || true)"
repo="${GITHUB_REPOSITORY:-vsemvamdam/rush-b}"
tmp="$(mktemp -d)"
mkdir -p "$tmp/matches"
cp "$src"/*.json "$tmp/matches/"
printf '# %s\n\nСлужебная ветка: статистика матчей CS2 для сайта (`matches/<steamid>.json`).\nОбновляется workflow «Мои матчи CS2» и всегда состоит из одного коммита — не коммитьте сюда.\n' "$branch" > "$tmp/README.md"
cd "$tmp"
git init -q -b "$branch"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -qm "Статистика матчей CS2 (автоматически)"
if [ -n "$auth" ]; then
  git -c "http.https://github.com/.extraheader=$auth" push -q -f "https://github.com/${repo}.git" "HEAD:$branch"
else
  git push -q -f "https://github.com/${repo}.git" "HEAD:$branch"
fi
echo "ветка $branch обновлена"
