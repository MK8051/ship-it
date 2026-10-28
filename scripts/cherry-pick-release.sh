#!/usr/bin/env bash
#
# Cherry-pick the commits from one or more GitHub PRs onto a base ref (a tag
# or a branch), then either:
#   - tag the result and push the tag (--tag <name>), or
#   - push the result as a brand new branch (--branch <name>), ready for a PR, or
#   - fetch an ALREADY-EXISTING branch and push more commits onto it
#     (--update-branch <name>) — no --base needed, it starts from that
#     branch's own current tip.
#
# Usage:
#   scripts/cherry-pick-release.sh --base <ref> --tag <new_tag> [--prs <pr1,pr2,...>] [--commits <sha1,sha2,...>] \
#       [--repo owner/name] [--remote origin] [--dry-run]
#   scripts/cherry-pick-release.sh --base <ref> --branch <new_branch> [--prs <pr1,pr2,...>] [--commits <sha1,sha2,...>] \
#       [--repo owner/name] [--remote origin] [--dry-run]
#   scripts/cherry-pick-release.sh --update-branch <existing_branch> [--prs <pr1,pr2,...>] [--commits <sha1,sha2,...>] \
#       [--repo owner/name] [--remote origin] [--dry-run]
#   scripts/cherry-pick-release.sh --continue
#   scripts/cherry-pick-release.sh --abort
#
# At least one of --prs / --commits is required; both may be given together
# (PR commits are applied first, then the direct commit SHAs).
#
# Requires: git, and either the GitHub CLI (`gh`, already authenticated) or
# curl + jq with a GITHUB_TOKEN env var (needed for private repos).
#
# What it does:
#   1. Fetches each PR's exact commit list from the GitHub API, in the order
#      GitHub reports them (authoritative regardless of merge/squash/rebase
#      strategy, and works even for PRs that aren't merged yet). Any commit
#      SHAs given directly via --commits are fetched individually and added
#      after the PR commits — useful for a commit with no PR at all.
#   2. Checks out the starting point on a scratch branch: --base (tried as a
#      branch first, then as a tag) for --tag/--branch, or the existing
#      branch's own current tip for --update-branch.
#   3. Cherry-picks every commit in order: PR commits first (in PR order
#      given, each PR's own commit order), then direct commits.
#   4. Auto-skips a cherry-pick that becomes empty after auto-merging (i.e.
#      the change is already present on this branch through other history) —
#      this is common when two long-lived branches diverged and re-converged.
#   5. On a genuine conflict, stops and tells you exactly how to resolve it,
#      then resume with --continue.
#   6. Once all commits are applied: in --tag mode, tags HEAD and pushes the
#      tag; in --branch/--update-branch mode, pushes the result as that
#      branch (no tag).
#
set -euo pipefail

REMOTE="origin"
DRY_RUN=0
MODE="run"
BASE=""
NEW_TAG=""
NEW_BRANCH=""
UPDATING_EXISTING=0
PR_LIST_RAW=""
COMMITS_RAW=""
REPO=""

STATE_DIR="$(git rev-parse --git-dir 2>/dev/null || echo .git)/cherry-pick-app"
STATE_FILE="${STATE_DIR}/state"
WORK_BRANCH_FILE="${STATE_DIR}/work-branch"
TARGET_MODE_FILE="${STATE_DIR}/target-mode"
TARGET_NAME_FILE="${STATE_DIR}/target-name"
REMOTE_FILE="${STATE_DIR}/remote"

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

log()  { printf '>> %s\n' "$1"; }
err()  { printf 'ERROR: %s\n' "$1" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --tag) NEW_TAG="$2"; shift 2 ;;
    --branch) NEW_BRANCH="$2"; shift 2 ;;
    --update-branch) NEW_BRANCH="$2"; UPDATING_EXISTING=1; shift 2 ;;
    --prs) PR_LIST_RAW="$2"; shift 2 ;;
    --commits) COMMITS_RAW="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --continue) MODE="continue"; shift ;;
    --abort) MODE="abort"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown argument: $1"; usage; exit 1 ;;
  esac
done

detect_repo() {
  [ -n "$REPO" ] && return
  url="$(git remote get-url "$REMOTE")"
  case "$url" in
    git@github.com:*) REPO="${url#git@github.com:}"; REPO="${REPO%.git}" ;;
    https://github.com/*) REPO="${url#https://github.com/}"; REPO="${REPO%.git}" ;;
    *) err "cannot infer owner/repo from remote URL: $url (pass --repo owner/name)"; exit 1 ;;
  esac
}

# Prints commit SHAs for a PR, oldest-first, one per line.
pr_commits() {
  pr="$1"
  if command -v gh >/dev/null 2>&1; then
    gh api "repos/${REPO}/pulls/${pr}/commits" --paginate --jq '.[].sha'
  else
    if [ -z "${GITHUB_TOKEN:-}" ]; then
      err "gh CLI not found and GITHUB_TOKEN is not set; cannot query the GitHub API"
      exit 1
    fi
    page=1
    while :; do
      out="$(curl -sf -H "Authorization: Bearer ${GITHUB_TOKEN}" \
                  -H "Accept: application/vnd.github+json" \
                  "https://api.github.com/repos/${REPO}/pulls/${pr}/commits?per_page=100&page=${page}")"
      count="$(printf '%s' "$out" | jq 'length')"
      [ "$count" -eq 0 ] && break
      printf '%s\n' "$out" | jq -r '.[].sha'
      [ "$count" -lt 100 ] && break
      page=$((page + 1))
    done
  fi
}

require_clean_tree() {
  if [ -n "$(git status --porcelain)" ]; then
    err "working tree is not clean. Commit, stash, or discard changes first."
    exit 1
  fi
}

save_state() {
  # remaining commits, one per line. `printf '%s\n'` with zero args still
  # emits one blank line, so guard the empty case explicitly.
  if [ "$#" -eq 0 ]; then
    : > "$STATE_FILE"
  else
    printf '%s\n' "$@" > "$STATE_FILE"
  fi
}

do_abort() {
  if [ -f "$WORK_BRANCH_FILE" ]; then
    branch="$(cat "$WORK_BRANCH_FILE")"
    if git rev-parse --verify "$branch" >/dev/null 2>&1; then
      git cherry-pick --abort 2>/dev/null || true
      git checkout - >/dev/null 2>&1 || true
      git branch -D "$branch" 2>/dev/null || true
      log "removed scratch branch $branch"
    fi
  fi
  rm -rf "$STATE_DIR"
  log "state cleared"
}

# Fetches BASE as a branch first, falling back to a tag. Sets BASE_REF to the
# fully-qualified local ref to check out.
fetch_base_ref() {
  if git fetch "$REMOTE" "+refs/heads/${BASE}:refs/remotes/${REMOTE}/${BASE}" 2>/dev/null; then
    BASE_REF="refs/remotes/${REMOTE}/${BASE}"
  elif git fetch "$REMOTE" "+refs/tags/${BASE}:refs/tags/${BASE}" 2>/dev/null; then
    BASE_REF="refs/tags/${BASE}"
  else
    err "could not find '${BASE}' as a branch or tag on ${REMOTE}"
    exit 1
  fi
}

finish_run() {
  target_mode="$1"
  name="$2"
  remote="$3"
  work_branch="$4"

  if [ "$target_mode" = "tag" ]; then
    if git rev-parse -q --verify "refs/tags/${name}" >/dev/null; then
      err "tag ${name} already exists locally"
      exit 1
    fi
    git tag "$name" HEAD
    git checkout "$name"
    git branch -D "$work_branch" 2>/dev/null || true
    git push "$remote" "$name"
    rm -rf "$STATE_DIR"
    log "tag ${name} created and pushed to ${remote}"
  else
    # Whether this branch is brand new or already existed on the remote, the
    # push itself is identical: local history is either genuinely new, or a
    # fast-forward of what we fetched as the starting point.
    git branch -m "$name"
    git push -u "$remote" "$name"
    rm -rf "$STATE_DIR"
    log "branch ${name} pushed to ${remote}"
  fi
}

# Cherry-picks a single commit. Returns 0 on success (applied or skipped-empty),
# 2 on a genuine conflict that needs manual resolution.
cherry_pick_one() {
  sha="$1"
  if git cherry-pick "$sha" >/tmp/cp_out_$$.log 2>&1; then
    subj="$(git log -1 --format=%s "$sha")"
    log "applied $sha  $subj"
    rm -f /tmp/cp_out_$$.log
    return 0
  fi

  if git status --porcelain | grep -qE '^(U|AA|DD)'; then
    subj="$(git log -1 --format=%s "$sha" 2>/dev/null || echo "$sha")"
    err "conflict applying $sha ($subj)"
    echo
    echo "Resolve it, then run:"
    echo "  git add <resolved files>"
    echo "  git cherry-pick --continue"
    echo
    echo "Once that succeeds, resume this script with:"
    echo "  $0 --continue"
    rm -f /tmp/cp_out_$$.log
    return 2
  fi

  # No conflict markers -> most likely the change is already present
  # (auto-merge succeeded but left nothing to commit).
  if git diff --cached --quiet && git diff --quiet; then
    subj="$(git log -1 --format=%s "$sha" 2>/dev/null || echo "$sha")"
    if ! git cherry-pick --skip >/tmp/cp_skip_$$.log 2>&1; then
      err "failed to skip empty cherry-pick for $sha ($subj):"
      cat /tmp/cp_skip_$$.log >&2
      rm -f /tmp/cp_out_$$.log /tmp/cp_skip_$$.log
      return 2
    fi
    log "skipped $sha ($subj) — already present, cherry-pick was empty"
    rm -f /tmp/cp_out_$$.log /tmp/cp_skip_$$.log
    return 0
  fi

  err "unexpected cherry-pick failure on $sha:"
  cat /tmp/cp_out_$$.log >&2
  rm -f /tmp/cp_out_$$.log
  return 2
}

run_queue() {
  target_mode="$1"; name="$2"; remote="$3"; work_branch="$4"; shift 4
  commits=("$@")
  total=${#commits[@]}
  for i in "${!commits[@]}"; do
    sha="${commits[$i]}"
    # Call outside the `if` condition: bash disables `set -e` for every
    # command nested inside a function that is itself the direct subject
    # of an if/while test, which would silently swallow real failures here.
    rc=0
    cherry_pick_one "$sha" || rc=$?
    if [ "$rc" -ne 0 ]; then
      remaining=("${commits[@]:$((i))}")
      # remaining[0] is the one currently mid-conflict; leave it out of the
      # saved queue since --continue expects it already resolved.
      save_state "${remaining[@]:1}"
      echo "$target_mode" > "$TARGET_MODE_FILE"
      echo "$name" > "$TARGET_NAME_FILE"
      echo "$remote" > "$REMOTE_FILE"
      echo "$work_branch" > "$WORK_BRANCH_FILE"
      exit 1
    fi
  done
  finish_run "$target_mode" "$name" "$remote" "$work_branch"
}

if [ "$MODE" = "abort" ]; then
  do_abort
  exit 0
fi

if [ "$MODE" = "continue" ]; then
  [ -f "$STATE_FILE" ] || { err "no in-progress run found (${STATE_FILE} missing)"; exit 1; }
  if [ -n "$(git status --porcelain --ignore-submodules)" ] && [ -f "$(git rev-parse --git-dir)/CHERRY_PICK_HEAD" ]; then
    err "a cherry-pick is still unresolved. Finish it first: git add <files> && git cherry-pick --continue"
    exit 1
  fi
  mapfile -t remaining < "$STATE_FILE"
  target_mode="$(cat "$TARGET_MODE_FILE")"
  name="$(cat "$TARGET_NAME_FILE")"
  remote="$(cat "$REMOTE_FILE")"
  work_branch="$(cat "$WORK_BRANCH_FILE")"
  if [ ${#remaining[@]} -eq 0 ]; then
    finish_run "$target_mode" "$name" "$remote" "$work_branch"
    exit 0
  fi
  run_queue "$target_mode" "$name" "$remote" "$work_branch" "${remaining[@]}"
  exit 0
fi

# ---- fresh run ----
if [ -n "$NEW_TAG" ] && [ -n "$NEW_BRANCH" ]; then
  err "pass exactly one of --tag, --branch, or --update-branch"; usage; exit 1
fi
if [ -z "$NEW_TAG" ] && [ -z "$NEW_BRANCH" ]; then
  err "one of --tag <name>, --branch <name>, or --update-branch <name> is required"; usage; exit 1
fi
if [ "$UPDATING_EXISTING" -eq 0 ]; then
  [ -n "$BASE" ] || { err "--base <ref> is required (unless using --update-branch)"; usage; exit 1; }
fi
if [ -z "$PR_LIST_RAW" ] && [ -z "$COMMITS_RAW" ]; then
  err "at least one of --prs <pr1,pr2,...> or --commits <sha1,sha2,...> is required"; usage; exit 1
fi
[ -f "$STATE_FILE" ] && { err "a previous run is still in progress. Use --continue or --abort."; exit 1; }

detect_repo
require_clean_tree

if [ -n "$NEW_TAG" ]; then
  TARGET_MODE="tag"
  TARGET_NAME="$NEW_TAG"
  if git rev-parse -q --verify "refs/tags/${TARGET_NAME}" >/dev/null; then
    err "tag ${TARGET_NAME} already exists locally"; exit 1
  fi
  if git ls-remote --tags "$REMOTE" | grep -q "refs/tags/${TARGET_NAME}\$"; then
    err "tag ${TARGET_NAME} already exists on ${REMOTE}"; exit 1
  fi
else
  TARGET_MODE="branch"
  TARGET_NAME="$NEW_BRANCH"
  if [ "$UPDATING_EXISTING" -eq 1 ]; then
    if ! git ls-remote --heads "$REMOTE" | grep -q "refs/heads/${TARGET_NAME}\$"; then
      err "branch ${TARGET_NAME} does not exist on ${REMOTE} — use --branch instead of --update-branch to create it"
      exit 1
    fi
  else
    if git ls-remote --heads "$REMOTE" | grep -q "refs/heads/${TARGET_NAME}\$"; then
      err "branch ${TARGET_NAME} already exists on ${REMOTE}"; exit 1
    fi
  fi
fi

PR_LIST=()
[ -n "$PR_LIST_RAW" ] && IFS=',' read -r -a PR_LIST <<< "$PR_LIST_RAW"
COMMIT_LIST=()
[ -n "$COMMITS_RAW" ] && IFS=',' read -r -a COMMIT_LIST <<< "$COMMITS_RAW"

if [ "$UPDATING_EXISTING" -eq 1 ]; then
  log "fetching existing branch ${TARGET_NAME} to update"
  git fetch "$REMOTE" "+refs/heads/${TARGET_NAME}:refs/remotes/${REMOTE}/${TARGET_NAME}"
  BASE_REF="refs/remotes/${REMOTE}/${TARGET_NAME}"
else
  log "fetching base ${BASE}"
  fetch_base_ref
fi

ALL_COMMITS=()
for pr in "${PR_LIST[@]}"; do
  log "fetching PR #${pr} head"
  git fetch "$REMOTE" "+refs/pull/${pr}/head:refs/remotes/pr/${pr}" >/dev/null
  log "resolving commit list for PR #${pr} (${REPO})"
  while IFS= read -r sha; do
    [ -n "$sha" ] && ALL_COMMITS+=("$sha")
  done < <(pr_commits "$pr")
done

for sha in "${COMMIT_LIST[@]}"; do
  case "$sha" in
    [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*) ;;
    *) err "'${sha}' doesn't look like a commit SHA (need at least 7 hex characters)"; exit 1 ;;
  esac
  log "fetching commit ${sha}"
  if ! git fetch "$REMOTE" "$sha" >/dev/null 2>&1; then
    err "could not fetch commit ${sha} from ${REMOTE} — check it exists on this repo"
    exit 1
  fi
  ALL_COMMITS+=("$sha")
done

if [ ${#ALL_COMMITS[@]} -eq 0 ]; then
  err "no commits found across the given PRs/commits"
  exit 1
fi

log "cherry-pick plan ($((${#ALL_COMMITS[@]})) commits):"
for sha in "${ALL_COMMITS[@]}"; do
  printf '    %s  %s\n' "${sha:0:9}" "$(git log -1 --format=%s "$sha" 2>/dev/null || echo '(not fetched)')"
done

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run — not applying anything"
  exit 0
fi

WORK_BRANCH="cherry-pick/${TARGET_NAME}"
git checkout -B "$WORK_BRANCH" "$BASE_REF"
mkdir -p "$STATE_DIR"

run_queue "$TARGET_MODE" "$TARGET_NAME" "$REMOTE" "$WORK_BRANCH" "${ALL_COMMITS[@]}"
