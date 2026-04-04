---
name: update-docs-from-commits
description: Scan recent git commits for changes that affect user-facing behavior, then draft or update the corresponding documentation pages. Use when docs have fallen behind code changes, after a batch of features lands, or when preparing a release. Trigger keywords - update docs, draft docs, docs from commits, sync docs, catch up docs, doc debt, docs behind, docs drift.
---

# Update Docs from Commits

Scan recent git history for commits that affect user-facing behavior and draft documentation updates for each.

## Prerequisites

- You must be in the openclaw git repository.
- The `docs/` directory must exist with the current doc set.
- Docs are hosted on Mintlify (docs.openclaw.ai). Follow the linking and formatting conventions in `AGENTS.md`.

## When to Use

- After a batch of features or fixes has landed and docs may be stale.
- Before a release, to catch any doc gaps.
- When a contributor asks "what docs need updating?"

## Step 1: Identify Relevant Commits

Determine the commit range. The user may provide one explicitly (e.g., "since v2025.4.1" or "last 30 commits"). If not, default to commits since the latest tag or the last 50 commits.

```bash
git log --oneline --no-merges -50
```

Filter to commits that are likely to affect docs. Look for these signals:

1. **Commit type**: `feat`, `fix`, `refactor`, `perf` commits often change behavior. `docs` commits are already doc changes. `chore`, `ci`, `test` commits rarely need doc updates.
2. **Files changed**: Changes to `src/commands/`, `src/cli/`, `src/channels/`, `src/plugins/`, `src/plugin-sdk/`, `src/gateway/`, `src/routing/`, or bundled plugin packages are high-signal.
3. **Ignore**: Changes limited to `*.test.ts`, `.github/`, `scripts/`, or internal-only modules with no user-facing behavior.

```bash
git log --oneline --no-merges --name-only -50
```

## Step 2: Map Commits to Doc Pages

For each relevant commit, determine which doc page(s) it affects. Use this mapping as a starting point:

| Code area | Likely doc page(s) |
|---|---|
| `src/cli/`, `src/commands/` | `docs/reference/` or relevant command docs |
| `src/channels/`, `src/telegram/`, `src/discord/`, `src/slack/` | `docs/channels/` |
| `src/plugins/`, `src/plugin-sdk/` | `docs/plugins/` |
| `src/gateway/protocol/` | `docs/gateway/` |
| `src/routing/` | `docs/concepts/` or channel docs |
| `src/media/` | `docs/concepts/` |
| Bundled plugin packages | `docs/plugins/` or channel-specific docs |
| Config schema changes | `docs/configuration.md` or relevant config section |
| `apps/macos/`, `apps/ios/`, `apps/android/` | Platform-specific docs under `docs/install/` or `docs/channels/` |

If a commit does not map to any existing page but introduces a user-visible concept, flag it as needing a new page.

## Step 3: Read the Commit Details

For each commit that needs a doc update, read the full diff to understand the change:

```bash
git show <commit-hash> --stat
git show <commit-hash>
```

Extract:

- What changed (new flag, renamed command, changed default, new feature).
- Why it changed (from the commit message body, linked issue, or PR description).
- Any breaking changes or migration steps.

## Step 4: Read the Current Doc Page

Before editing, read the full target doc page to understand its current content and structure.

Identify where the new content should go. Follow the page's existing structure.

## Step 5: Draft the Update

Write the doc update following the conventions in `AGENTS.md`. Key reminders:

- **Internal doc links**: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).
- **Section cross-references**: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).
- **Doc headings**: avoid em dashes and apostrophes in headings (they break Mintlify anchors).
- **Order services/providers alphabetically** in docs, UI copy, and picker lists.
- **Use American spelling** in all docs content.
- **Generic content**: no personal device names/hostnames/paths; use placeholders.
- **Product naming**: use **OpenClaw** for product/app/docs headings; use `openclaw` for CLI command, package, paths, and config keys.

When updating an existing page:

- Add content in the logical place within the existing structure.
- Do not reorganize sections unless the change requires it.
- Update any cross-references or "Next Steps" links if relevant.

When creating a new page:

- Follow the frontmatter template from existing docs pages.
- Add the page to the navigation in `docs/mint.json`.

## Step 6: Present the Results

After drafting all updates, present a summary to the user:

```
## Doc Updates from Commits

### Updated pages
- `docs/channels/telegram.md`: Added webhook retry documentation (from commit abc1234).
- `docs/plugins/manifest.md`: Updated manifest schema for new `autoEnable` field (from commit def5678).

### New pages needed
- None (or list any new pages created).

### Commits with no doc impact
- `chore(deps): bump vitest` (abc1234) — internal dependency, no user-facing change.
- `test: add webhook retry test` (def5678) — test-only change.
```

End the reply with the `https://docs.openclaw.ai/...` URLs you referenced.

## Step 7: Verify

After making changes, check for:

- Broken cross-references (root-relative links without `.md`).
- Correct rendering of new content.
- Consistent terminology with the rest of the docs.

## Tips

- When in doubt about whether a commit needs a doc update, check if the commit message references a CLI flag, config option, or user-visible behavior.
- Group related commits that touch the same doc page into a single update rather than making multiple small edits.
- If a commit is a breaking change, add a prominent note in the relevant section.
- PRs that are purely internal refactors with no behavior change do not need doc updates, even if they touch high-signal directories.
- Remember to check `docs/zh-CN/` — it's generated and should not be edited directly. Update English docs first, then the i18n pipeline handles translation.

## Example Usage

User says: "Catch up the docs for everything merged since v2025.4.1."

1. Run `git log v2025.4.1..HEAD --oneline --no-merges --name-only`.
2. Filter to `feat`, `fix`, `refactor`, `perf` commits touching user-facing code.
3. Map each to a doc page.
4. Read the commit diffs and current doc pages.
5. Draft updates following the style conventions.
6. Present the summary.
7. End with the docs URLs referenced.
