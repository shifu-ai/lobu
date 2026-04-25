---
description: Triage a PR — classify, optionally fix, optionally enable auto-merge.
---

# /triage-pr

Argument: PR number (or URL). Defaults to the current PR when invoked from CI via `$PR_NUMBER` env.

Exactly one of three terminal classifications: `auto-mergeable`, `needs-fixes`, `needs-human`. Each maps to a specific set of actions. The agent must finish each run by writing a `<!-- triage:summary -->` marker comment with the head SHA and decision so re-runs are idempotent.

## Phase A — Gather (read-only)

```bash
PR="${1:-$PR_NUMBER}"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

gh pr view "$PR" --json number,headRefName,headRefOid,author,isDraft,labels,baseRefName,statusCheckRollup,reviews,mergeable,mergeStateStatus,files,additions,deletions,title,body
gh api "repos/$REPO/pulls/$PR/comments"           # inline review comments (Codex, pi)
gh api "repos/$REPO/issues/$PR/comments"           # issue-level comments
gh api "repos/$REPO/pulls/$PR/reviews"             # formal reviews
```

If any comment body contains a `slack.com/archives/.+thread_ts=` URL, run `./scripts/slack-thread-viewer.js "<url>"` and include the result in your context (per AGENTS.md).

Read `.github/triage-config.yml` for label names and infra-path lists.

## Phase B — Hard gates (exit without acting)

Skip silently when:

- `isDraft == true`
- Labels include `triage:hold`
- The most recent `<!-- triage:summary -->` comment records the same `headRefOid` AND a terminal classification (`auto-mergeable` or `needs-human`)
- `additions + deletions > 1000` and `skip-size-check` not in labels (already failed in `pr-validation.yml`)

Classify as `needs-human` and exit when:

- Any changed file path is under `packages/owletto-web/` — submodule two-PR rule (AGENTS.md). The agent must never push a parent commit referencing an unmerged submodule SHA.
- Any changed file path is under `charts/lobu/`, `docker/`, `.github/workflows/`, or is `scripts/setup-dev.sh` — infra blast radius.
- Any review comment contains case-insensitive: `security`, `credential`, `token`, `secret`, `auth bypass`, `P0`, or `P1`.

(Forks are filtered at the workflow level via `setup-submodule.outputs.stubbed`; if you somehow get here on a fork, exit silently — pushing requires write access to the head ref.)

## Phase C — Classify

Apply rules in order; first match wins.

1. **`needs-human`** — see Phase B above; also when `mergeStateStatus == 'DIRTY'` (base conflict that needs human resolution).

2. **`needs-fixes`** — all of:
   - At least one inline review comment was posted *after* the latest commit on the PR head (heuristic: `comment.created_at > head_commit.committer.date`) and is unaddressed.
   - The fix is mechanical: lint/format, missing `.js` import suffix (TS NodeNext), unused vars (delete the var per AGENTS.md, never `_`-prefix), trivial type errors, missing trivial test.

3. **`auto-mergeable`** — all of:
   - `statusCheckRollup` entries all `SUCCESS`, `NEUTRAL`, or `SKIPPED`.
   - At least one `APPROVED` review (from `codex-approver[bot]`, you, or another human) since the latest commit on the PR head.
   - **No `CHANGES_REQUESTED` review** since the latest commit on the PR head. (A stale approval from before later pushback does not qualify.)
   - `mergeable == 'MERGEABLE'`.
   - No `triage:hold` label.

If none match (e.g., CI still running, no Codex review yet), classify as `pending` — no action, no marker comment, let the next event re-trigger.

## Phase D — Act

### `needs-human`

Read `assignee:` from `.github/triage-config.yml` (do NOT use `@me` — in CI it resolves to `github-actions[bot]`).

```bash
ASSIGNEE=$(grep '^assignee:' .github/triage-config.yml | awk '{print $2}')
gh pr edit "$PR" --add-label "triage:needs-human" --add-assignee "$ASSIGNEE"
```

Upsert the marker comment (Phase E) with classification + reasons + links to the specific blocking comments.

### `needs-fixes`

1. Fetch and switch to a throwaway local branch (NEVER `git stash` per AGENTS.md):

   ```bash
   git fetch origin "pull/$PR/head:triage-$PR"
   git switch "triage-$PR"
   ```

2. Capture the original PR diff scope BEFORE making any edits — fixes and the staged commit must stay within these paths so a stray `bun run check:fix` reformat doesn't sweep unrelated files into the PR:

   ```bash
   gh pr diff "$PR" --name-only > /tmp/triage-scope.txt
   ```

3. Apply scoped fixes for the flagged comments. **Hard rules:**
   - Never modify tests except to fix typos.
   - Never edit anything under `/dist/` (existing hook blocks this).
   - Never use `npm` (existing hook blocks this — use `bun`).
   - Never `--no-verify` and never `--force` push.

4. Validate per AGENTS.md matrix:

   ```bash
   bun run check:fix                                # always
   # touched packages/landing/* ?
   (cd packages/landing && bun run build)
   # touched packages/{core,gateway,worker,cli}/* ?
   make build-packages
   # always — root catches drift the package-local checks miss:
   bun run typecheck
   # tests — biome/tsc don't catch behavioral regressions:
   bun run test
   ```

5. If validation fails: do NOT push. Reset the branch (`git reset --hard origin/<headRefName>`), downgrade classification to `needs-human`, comment `auto-fix attempt failed: <error excerpt>`, exit.

6. If validation passes — stage ONLY paths that were already in the PR diff scope:

   ```bash
   # Intersect dirty files with the original PR scope.
   git status --porcelain | awk '{print $2}' \
     | grep -Fxf /tmp/triage-scope.txt \
     | xargs -r git add --
   git commit -m "chore: address review comments"
   git push origin "HEAD:$(gh pr view "$PR" --json headRefName -q .headRefName)"
   gh pr edit "$PR" --add-label "triage:fixes-applied"
   ```

   If `bun run check:fix` reformatted files OUTSIDE the PR scope, leave them — that's repo-wide formatter drift, not a fix for this PR. Note it in the marker comment.

   On push rejection (race with another commit), downgrade to `needs-human`.

6. Exit. The push fires a `synchronize` event; the workflow re-runs and re-classifies the new head.

### `auto-mergeable`

```bash
gh pr edit "$PR" --add-label "triage:auto-mergeable"
gh pr merge "$PR" --auto --squash --delete-branch
```

Never `--admin`. Never `--rebase` or `--merge`. If the PR has been queued for auto-merge already, the second call is a no-op.

## Phase E — Record state (idempotency)

Find any existing comment whose body starts with `<!-- triage:summary -->`. If present, edit it; otherwise create one:

```text
<!-- triage:summary head=<headRefOid> ts=<iso8601> -->

**Triage decision:** `<auto-mergeable|needs-fixes|needs-human|pending>`

**Reasons:**
- bullet 1
- bullet 2

**Next:** <what happens next, e.g. "waiting on green CI", "fix commit pushed", "needs your review">
```

The marker line at the top is parsed by future runs to short-circuit on matching SHA.

## Conventions encoded (from AGENTS.md)

- **One branch = one concern.** If the PR mixes unrelated package roots without a unifying `feat:`/`fix:` scope in the title, classify `needs-human`.
- **Never split unnecessarily.** Do not propose splitting a PR whose title scope is consistent and whose size is under the 1000-line gate, even if it touches multiple files.
- **`.js` import suffix in TS sources.** When fixing imports, add `.js` extensions to relative imports (NodeNext resolution).
- **Typecheck drift.** Always run BOTH `make build-packages` (package-local tsc emit) and `bun run typecheck` (root tsc check) — they catch different things.
- **Submodule two-PR rule.** Any change under `packages/owletto-web/` → `needs-human`, full stop.
- **Unused parameters.** Delete them; never prefix with `_`.
- **Bun, not npm.** Hooks enforce this.
