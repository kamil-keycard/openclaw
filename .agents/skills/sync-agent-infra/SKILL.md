---
name: sync-agent-infra
description: Detect and fix drift across agent-first infrastructure files. Ensures skill inventories, workflow chains, and cross-references stay consistent when skills or components change. Run after adding, removing, or renaming skills or components. Trigger keywords - sync agent infra, sync skills, update agent docs, check agent consistency, agent infra drift, sync contributing, sync agents.
---

# Sync Agent Infrastructure

Detect and fix drift across the agent-first infrastructure files. These files reference each other and must stay consistent:

| File | What it tracks |
|------|---------------|
| `AGENTS.md` / `CLAUDE.md` | Project identity, architecture overview, build/test commands, skill references |
| `.github/labeler.yml` | Label rules for channels, plugins, apps, docs |
| `.github/ISSUE_TEMPLATE/*.yml` | Issue templates with skill name references |
| `.github/pull_request_template.md` | PR submission template |
| `.agents/skills/*/SKILL.md` | Individual skill definitions with cross-references |
| `.agents/maintainers.md` | Maintainer workflow references |

## When to Run

- After adding, removing, or renaming a skill in `.agents/skills/`
- After adding, removing, or renaming a channel, plugin, or app
- After changing workflow chain relationships between skills
- After modifying issue or PR templates
- Before opening a PR that touches any of the above

## Prerequisites

You must be in the openclaw repository root.

## Step 1: Inventory Current State

Gather the source of truth for each category.

### Skills

List all skill directories:

```bash
ls -1 .agents/skills/
```

This is the canonical skill list. Every other file must agree with it.

### Source Modules

Key source areas to track:

```bash
ls -1 src/
```

And the bundled plugin packages in the workspace plugin tree.

### Labels

Check `.github/labeler.yml` for label rules that reference channels, plugins, and apps.

## Step 2: Check Each File for Drift

For each file in the table above, check for the following inconsistencies:

### `AGENTS.md` / `CLAUDE.md`

1. **Skill references** — Every skill mentioned in the guidelines must exist in `.agents/skills/`. Skills removed from the directory must be removed from all references.
2. **Architecture boundaries** — Verify that boundary guide references (`src/plugin-sdk/AGENTS.md`, `src/channels/AGENTS.md`, etc.) still exist.
3. **Build/test commands** — Verify commands are current (`pnpm check`, `pnpm test`, `pnpm build`).

### `.github/labeler.yml`

1. **Channel labels** — Every built-in and bundled plugin channel should have a label rule.
2. **Plugin labels** — Every bundled plugin should have a label rule.
3. **App labels** — iOS, Android, macOS apps should have label rules.

### Issue/PR Templates

1. **Skill references** — Any skill mentioned in templates must exist in `.agents/skills/`.
2. **Label references** — Labels referenced in templates must exist.

### Skill Cross-References

1. **Companion skills** — Skills that reference other skills (e.g., `create-spike` references `build-from-issue`) must have valid targets.
2. **Workflow chains** — If skills define a workflow sequence (spike → build), verify all steps exist.

## Step 3: Report Drift

If any inconsistencies are found, report them in a structured format:

```markdown
## Agent Infrastructure Drift Report

### Skills Inventory
- ADDED (exists in .agents/skills/ but missing from references): <list>
- REMOVED (referenced but missing from .agents/skills/): <list>
- OK: <count> skills consistent

### Label Rules
- MISSING: <channel/plugin without label rule>
- STALE: <label rule for removed channel/plugin>
- OK: <count> labels consistent

### Cross-References
- <file>:<line> references non-existent skill <skill>
- <file>:<line> references non-existent label <label>
- OK: <count> references consistent
```

If no drift is found, report: "Agent infrastructure is consistent. No drift detected."

## Step 4: Fix Drift

If drift is found, fix it by updating the affected files:

1. **Added skill** — Add references in relevant docs. If it participates in a workflow chain, update chain descriptions.
2. **Removed skill** — Remove it from all files. Check for references in templates and other skills.
3. **Renamed skill** — Update every reference across all files.
4. **Added channel/plugin** — Add label rules in `.github/labeler.yml` and create matching GitHub labels.
5. **Removed channel/plugin** — Remove label rules and clean up references.

After fixing, re-run Step 2 to verify consistency.

## Step 5: Summarize Changes

Report what was fixed:

```markdown
## Changes Made
- Updated AGENTS.md: removed reference to deleted skill `<skill>`
- Updated .github/labeler.yml: added label rule for `<channel>`
- Fixed cross-reference in `.agents/skills/<skill>/SKILL.md`: `<old>` → `<new>`
```
