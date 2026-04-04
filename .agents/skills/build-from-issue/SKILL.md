---
name: build-from-issue
description: Given a spec file in docs/specs/, plan and implement the work described in the spec. Operates iteratively - analyzes the spec, creates an implementation plan, gets user approval, then builds. Includes tests, documentation updates, and commits. Trigger keywords - build from spec, implement spec, work on spec, build spec, start spec, build from issue.
---

# Build From Spec

Plan, iterate on feedback, and implement work described in a spec file under `docs/specs/`.

This skill operates as a stateful workflow — the user provides a spec file, the agent creates a plan, the user approves, and the agent builds.

## Prerequisites

- You must be in the openclaw git repository
- A spec file must exist in `docs/specs/`

## Workflow Overview

```
Read spec file from docs/specs/
  │
  ├─ Analyze spec (deep codebase investigation)
  │   → Present plan to user
  │   → STOP and wait for approval
  │
  ├─ User approves plan
  │   → Scope check (warn if high complexity)
  │   → Create branch
  │   → Implement changes
  │   → Write tests
  │   → Verify (tests + lint)
  │   → Update documentation
  │   → Commit
  │
  └─ User requests changes to plan
      → Revise plan
      → Present updated plan
      → STOP and wait for approval
```

## Step 1: Read the Spec

The user provides a spec file name or path (e.g., `FEATURE-SPEC.md` or `docs/specs/FEATURE-SPEC.md`). Resolve the path to `docs/specs/<name>` and read the file.

If the file does not exist, list available specs:

```bash
ls docs/specs/
```

Report the available specs and ask the user which one to build from.

## Step 2: Analyze the Spec

Perform a thorough codebase investigation:

1. Read the spec thoroughly and identify what needs to change in the codebase.
2. Map the requirements to existing code — read the relevant source files under `src/`, bundled plugin packages, or `docs/`.
3. Determine the **issue type** — one of: `feat` (new feature), `fix` (bug fix), `refactor`, `chore`, `perf`, `docs`.
4. Propose the minimal set of changes that satisfies the requirements.
5. Sequence the work so each step is independently testable.
6. Identify what tests are needed (unit, integration) and where they should live (colocated `*.test.ts` files).
7. Assess **complexity** on a scale:
   - **Low**: Isolated change, < 3 files, clear path forward
   - **Medium**: Multiple files/components, some design decisions, but well-scoped
   - **High**: Cross-cutting changes, architectural decisions needed, significant unknowns
8. Call out risks, unknowns, and decisions that need stakeholder input.

## Step 3: Present the Plan

Present the plan to the user in this format:

```
## Implementation Plan

**Spec:** `<spec file name>`
**Issue type:** `<feat|fix|refactor|chore|perf|docs>`
**Complexity:** <Low|Medium|High>
**Confidence:** <High — clear path | Medium — some unknowns | Low — needs discussion>

### Summary
<2-3 sentences describing what will be built/changed and the approach>

### Scope
- `<file1>`: <what changes and why>
- `<file2>`: <what changes and why>
- ...

### Implementation Steps
1. <step 1 — independently testable>
2. <step 2>
3. ...

### Test Plan
- **Unit tests:** <what will be tested and which colocated *.test.ts files>
- **Integration tests:** <what will be tested, or "N/A" with rationale>

### Risks & Open Questions
- <risk or unknown that may need human input>

### Documentation Impact
- <which docs pages will need updating, or "None expected">
```

Ask the user to approve the plan or provide feedback. **Do not proceed to build until the user explicitly approves.**

## Step 4: Scope Check

After user approval, check the **Complexity** and **Confidence** fields.

- **If Complexity is High or Confidence is Low**, warn the user:

  > "This spec is rated High complexity / Low confidence. The plan includes open questions that may need human decisions during implementation. Proceeding, but flagging this for your awareness."

  Continue — do not hard-stop. The user chose to approve.

## Step 5: Create Branch

Determine the branch prefix from the issue type in the plan:

| Issue type | Branch prefix |
| --- | --- |
| `feat` | `feat/` |
| `fix` | `fix/` |
| `refactor` | `refactor/` |
| `chore` | `chore/` |
| `perf` | `perf/` |
| `docs` | `docs/` |

Create the branch:

```bash
git checkout main
git pull origin main
git checkout -b <prefix><short-description>
```

Use a concise, descriptive branch name derived from the spec (e.g., `feat/matrix-channel`, `fix/webhook-retry`).

## Step 6: Implement the Changes

Follow the implementation steps from the plan. Principles:

- **Follow the plan**: The plan was reviewed and approved. Stick to it unless you discover something that requires deviation.
- **Minimal scope**: Only change what the plan calls for. No unrelated refactors.
- **If you must deviate**: Note the deviation — it will be reported to the user.

Read the relevant source files before making changes. Implement step by step per the plan's sequence.

## Step 7: Write Tests

Write tests as specified in the plan's Test Plan section. Follow the project's existing test conventions (Vitest, colocated `*.test.ts` files).

### Unit tests

- Place alongside the source file as `<name>.test.ts`
- Cover the new/changed behavior, edge cases, and error paths
- Ensure pre-existing behavior still works
- Clean up timers, env, globals, mocks, sockets, temp dirs, and module state so `--isolate=false` stays green

### Integration tests

- Place alongside the source or in a dedicated `*.test.ts` file
- Cover interactions between the changed components
- Test realistic scenarios including error conditions

### Test naming

Use descriptive names that document intent:
- `"returns correct page count for paginated results"`
- `"rejects negative offset parameter"`
- `"retries after transient failure"`

## Step 8: Verify — Tests and Lint (Retry Loop)

Run verification with up to **3 attempts**.

On each attempt:

```bash
pnpm check
pnpm test <path-to-relevant-test-files>
```

**If verification fails:**

1. Read the error output carefully.
2. Fix the issues (test failures, lint errors, formatting).
3. Decrement the retry counter and try again.

**If all 3 attempts fail**, stop and report to the user:
- What passed and what failed
- The specific errors from the last attempt
- That manual intervention is needed

Do not proceed to commits if verification is not green.

## Step 9: Update Documentation

If the change affects user-facing behavior, update the relevant docs in `docs/`:

- Check which docs pages are affected by the change
- Update command references, configuration docs, or concept pages
- Follow the docs conventions in `AGENTS.md` (Mintlify, root-relative links, no `.md` suffix)

## Step 10: Commit

Commit all changes using the repo's committer script:

```bash
scripts/committer "<type>(<scope>): <short description>" <files...>
```

Use conventional commit format. The `<type>` comes from the issue type in the plan.

## Step 11: Report to User

After committing, report a summary:

- **Spec:** which spec was built
- **Branch:** the branch name
- **What was built:** 1-2 sentence summary
- **Tests:** count of tests added (unit / integration)
- **Docs updated:** list of updated docs, or "None needed"
- **Deviations from plan:** any deviations, or "None — implemented as planned"

## Example Usage

### First run — generate plan

User says: "Build from spec MATRIX-CHANNEL-SPEC.md"

1. Read `docs/specs/MATRIX-CHANNEL-SPEC.md`
2. Investigate the codebase to map the spec to code
3. Produce a plan: feat type, Medium complexity, 5 implementation steps, unit tests needed
4. Present the plan to the user
5. Ask for approval — stop and wait

### Second run — user provides feedback

User says: "Looks good but skip the onboarding flow for now"

1. Revise the plan to remove onboarding scope
2. Present updated plan
3. Ask for approval — stop and wait

### Third run — user approves

User says: "Approved, go ahead"

1. Scope check: Medium complexity — proceed
2. Create branch `feat/matrix-channel`
3. Implement changes per the plan
4. Add unit tests for the new channel plugin
5. `pnpm check` and scoped tests pass on first attempt
6. Update `docs/channels/matrix.md` if applicable
7. Commit with conventional commit message
8. Report summary to user
