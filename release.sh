#!/usr/bin/env bash
#
# Bump the version of BOTH workspaces for a release, in one commit.
#
# Versions are bumped here — deliberately NOT per commit on feature branches.
# A feature branch that touches package.json makes every MR carry a meaningless
# diff in the repo's most conflict-prone file, and because each branch bumps from
# its own base the merged result depends on merge order and can go backwards.
#
# Usage:
#   ./release.sh patch|minor|major
#
# Optional:
#   DRY_RUN=1   - show what WOULD change; makes no commit and leaves the bump
#                 in the working tree for inspection (revert with git checkout).
#
# Run this on a release branch cut from an up-to-date main, then open an MR:
#
#   git checkout -b chore/release-v0.30.0 origin/main
#   ./release.sh minor
#   git push -u origin chore/release-v0.30.0
#   # ... MR review + merge ...
#   git fetch origin
#   git tag -a v0.30.0 -m "Release v0.30.0" origin/main
#   git push origin v0.30.0
#
# Tagging is a separate step AFTER the MR merges because committing directly to
# main is prohibited — the bump goes through review like any other change.
#
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
LEVEL="${1:-}"

case "$LEVEL" in
  patch|minor|major) ;;
  *)
    echo "usage: ./release.sh patch|minor|major" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

WORKSPACES=(dx-visualizer backend)

# --- Guards ------------------------------------------------------------------
# A dirty tree would get swept into the release commit below.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "!! Working tree is dirty. Commit or stash first." >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "main" ]; then
  echo "!! Refusing to run on main — committing directly to main is prohibited." >&2
  echo "   Cut a branch first: git checkout -b chore/release-vX.Y.Z origin/main" >&2
  exit 1
fi

# Bumping from a stale main reintroduces exactly the non-monotonic versions this
# script exists to prevent. A fetch failure (no SSH agent, offline) is a warning
# rather than fatal — the ancestry check still runs against the local ref.
if ! git fetch origin main --quiet 2>/dev/null; then
  echo ">> WARNING: could not fetch origin/main; checking against the local ref."
  echo "   If it is stale, rebase before pushing."
fi
if git rev-parse --verify --quiet origin/main >/dev/null; then
  if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "!! origin/main is not an ancestor of HEAD — your branch is behind." >&2
    echo "   Rebase first: git rebase origin/main" >&2
    exit 1
  fi
else
  echo ">> WARNING: no origin/main ref found; skipping the staleness check." >&2
fi

# --- Bump --------------------------------------------------------------------
# `npm version --no-git-tag-version` updates package.json AND package-lock.json
# together. That pairing is the point: the old post-commit hook only ever edited
# package.json, so the lockfile's embedded version silently drifted behind and
# that drift reached the public mirror.
for ws in "${WORKSPACES[@]}"; do
  before="$(node -p "require('./$ws/package.json').version")"
  (cd "$ws" && npm version "$LEVEL" --no-git-tag-version >/dev/null)
  after="$(node -p "require('./$ws/package.json').version")"
  echo ">> $ws: $before -> $after"
done

APP_VERSION="$(node -p "require('./dx-visualizer/package.json').version")"

# Sanity-check that the lockfiles actually moved in step with package.json.
for ws in "${WORKSPACES[@]}"; do
  pkg_v="$(node -p "require('./$ws/package.json').version")"
  lock_v="$(node -p "require('./$ws/package-lock.json').version")"
  if [ "$pkg_v" != "$lock_v" ]; then
    echo "!! $ws: package.json ($pkg_v) and package-lock.json ($lock_v) disagree." >&2
    echo "   Run 'npm install --package-lock-only' in $ws and re-check." >&2
    exit 1
  fi
done

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo ">> [DRY RUN] No commit made. Changes left in the working tree:"
  git --no-pager diff --stat
  echo
  revert_paths=""
  for ws in "${WORKSPACES[@]}"; do
    revert_paths+="$ws/package.json $ws/package-lock.json "
  done
  echo "   Revert with: git checkout -- $revert_paths"
  exit 0
fi

# --- Commit ------------------------------------------------------------------
for ws in "${WORKSPACES[@]}"; do
  git add "$ws/package.json" "$ws/package-lock.json"
done

git commit -q -m "chore(release): v${APP_VERSION}

Bumps both workspaces and their lockfiles. Tag v${APP_VERSION} after this
merges to main."

echo
echo ">> Committed:"
git --no-pager log -1 --stat --format='   %h %s'
echo
echo ">> Next:"
echo "   git push -u origin $BRANCH"
echo "   # open MR, review, merge, then:"
echo "   git fetch origin && git tag -a v${APP_VERSION} -m 'Release v${APP_VERSION}' origin/main"
echo "   git push origin v${APP_VERSION}"
