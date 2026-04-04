---
name: create-spike
description: Investigate a plain-language problem description by deeply exploring the codebase, then write a structured spike document in docs/specs/. Prequel to build-from-issue — maps vague ideas to concrete, buildable specs. Trigger keywords - spike, investigate, explore, research issue, technical investigation, create spike, new spike, feasibility, codebase exploration.
---

# Create Spike

Investigate a problem, map it to the codebase, and produce a structured spike document in `docs/specs/`.

A **spike** is an exploratory investigation. The user has a vague idea — a feature they want, a bug they've noticed, a performance concern — but hasn't mapped it to code, assessed feasibility, or structured it as a buildable issue. This skill does that mapping.

## Prerequisites

- You must be in the openclaw repository root

## Workflow Overview

```
User describes a problem
  │
  ├─ Step 1: Gather the problem statement
  │   └─ Ask ONE round of clarifying questions if genuinely needed
  │
  ├─ Step 2: Deep codebase investigation
  │   └─ Map the problem to code, assess feasibility, identify risks
  │
  ├─ Step 3: Write the spike document to docs/specs/
  │
  └─ Step 4: Report to user with file path and next steps
```

## Step 1: Gather the Problem Statement

The user provides a problem description. This could be:

- A feature idea: "I want to add a Matrix channel plugin"
- A bug report: "The Telegram webhook handler drops messages under load"
- A performance concern: "Plugin loading is slow with many installed plugins"
- A refactoring goal: "The channel routing logic is scattered across too many modules"

Extract from the user's input:

1. **What** they want (the desired outcome or observed problem)
2. **Why** they want it (motivation, use case, or trigger)
3. **Constraints** they've mentioned (backwards compatibility, performance targets, etc.)

### Clarification policy

If the problem is too vague to determine which area of the codebase to investigate, ask **ONE** round of clarifying questions. Do not over-interrogate. Examples of when to ask:

- "Make things faster" — ask which component or operation is slow
- "Fix the networking" — ask what specific behavior is wrong

Examples of when NOT to ask:

- "The Telegram webhook handler drops messages under load" — clear enough, start investigating
- "Add a new provider plugin for XAI" — clear enough, start investigating
- "The plugin SDK needs a new entrypoint for tool registration" — clear enough, start investigating

## Step 2: Deep Codebase Investigation

Perform a thorough codebase investigation. The investigation **must**:

1. **Identify which components/subsystems are involved.** Don't just guess from names — read the code to confirm. Key areas:
   - `src/` for core source code
   - `src/plugin-sdk/` for the public plugin contract
   - `src/channels/` for core channel implementation
   - `src/plugins/` for plugin discovery, validation, loader, registry
   - `src/gateway/protocol/` for Gateway wire protocol
   - Bundled workspace plugin packages for plugin examples
   - `docs/` for existing documentation

2. **Read the relevant source files thoroughly.** Not just grep for keywords — actually read and understand the logic. Follow the call chain from entry point through to the relevant behavior.

3. **Map the current architecture for the affected area.** How do the components interact? What's the data flow? Where are the boundaries?

4. **Identify the exact code paths that would need to change.** Provide file paths and line numbers. Name the functions, types, and modules.

5. **Assess feasibility and complexity:**
   - **Low**: Isolated change, < 3 files, clear path forward
   - **Medium**: Multiple files/components, some design decisions, but well-scoped
   - **High**: Cross-cutting changes, architectural decisions needed, significant unknowns

6. **Identify risks, edge cases, and design decisions that need human input.** What could go wrong? What trade-offs exist? What decisions shouldn't be made by an agent?

7. **Check for existing patterns in the codebase that should be followed.** If there's a convention for how similar features are implemented, note it. The implementation should be consistent.

8. **Look at relevant tests to understand test coverage expectations.** What test patterns exist? What level of coverage is expected for this area?

9. **Check docs** in the `docs/` directory for relevant documentation about the affected subsystems.

10. **Determine the issue type:** `feat`, `fix`, `refactor`, `chore`, `perf`, or `docs`.

## Step 3: Write the Spike Document

Write the spike as a markdown file in `docs/specs/`. Use the naming convention: `<UPPERCASE-HYPHENATED-DESCRIPTION>-SPIKE.md`.

Derive the filename from the problem description. Examples:

- "Add a Matrix channel plugin" → `MATRIX-CHANNEL-PLUGIN-SPIKE.md`
- "Telegram webhook drops messages" → `TELEGRAM-WEBHOOK-DROPS-SPIKE.md`
- "Cache compiled plugin manifests" → `PLUGIN-MANIFEST-CACHE-SPIKE.md`

The file should contain both the stakeholder-readable summary and the full technical investigation:

```markdown
## Problem Statement

<What and why — refined from the user's description. 2-4 sentences. Written for stakeholders, not just engineers.>

## Technical Context

<What the investigation found about the current architecture in the affected area. How things work today and why a change is needed.>

## Affected Components

| Component | Key Files | Role |
|-----------|-----------|------|
| <component> | `<file1>`, `<file2>` | <what this component does in the context of this change> |
| ... | ... | ... |

## Technical Investigation

### Architecture Overview

<How the affected subsystems work today. Include data flow, component interactions, and relevant design decisions. Reference docs if applicable.>

### Code References

| Location | Description |
|----------|-------------|
| `<file>:<line>` | <what this code does and why it's relevant> |
| `<file>:<line>` | <what this code does and why it's relevant> |
| ... | ... |

### Current Behavior

<What happens today in the code paths that would change. Be specific — name functions, trace the flow.>

### What Would Need to Change

<Detailed breakdown of modifications needed, organized by component. Include specific functions and types, but stop short of writing an implementation plan — that's `build-from-issue`'s job.>

### Alternative Approaches Considered

<If the investigation surfaced multiple viable approaches, describe them and note trade-offs. Flag which decisions need human input.>

### Patterns to Follow

<Existing patterns in the codebase that the implementation should be consistent with. Reference specific examples.>

## Proposed Approach

<High-level strategy — NOT a full implementation plan. That's `build-from-issue`'s job. Describe the direction, not the steps. 3-6 sentences.>

## Scope Assessment

- **Complexity:** <Low / Medium / High>
- **Confidence:** <High — clear path / Medium — some unknowns / Low — needs discussion>
- **Estimated files to change:** <count>
- **Issue type:** `<feat|fix|refactor|chore|perf|docs>`

## Risks & Open Questions

- <risk or unknown that needs human judgment>
- <design decision that could go either way>
- ...

## Test Considerations

- <what testing strategy makes sense for this change>
- <which test levels are needed: unit, integration>
- <any test infrastructure that may need to be added>
- <what tests exist for the affected area today, what patterns should be followed>

---
*Created by spike investigation. Use `build-from-issue` to plan and implement.*
```

## Step 4: Report to User

After writing the spike document, report:

1. The file path (e.g., `docs/specs/MATRIX-CHANNEL-PLUGIN-SPIKE.md`)
2. A 2-3 sentence summary of what was found
3. Key risks or decisions that need human attention
4. Next steps:

> Review the spike document. Refine the proposed approach if needed, then use `build-from-issue` to create an implementation plan and build it.

## Design Principles

1. **Everything goes in one document.** The spike file should contain both the stakeholder-readable summary and the full technical investigation, all in one place.

2. **Do NOT create an implementation plan.** The spike identifies the problem space and proposes a direction. The implementation plan is `build-from-issue`'s responsibility, created after human review of the spike.

3. **One round of clarification max.** Don't turn this into an interrogation. If the user provides enough to identify the area of the codebase, start investigating.

4. **The spike should save `build-from-issue` work.** When `build-from-issue` runs, the technical investigation section should contain enough detail that it can build on the investigation rather than starting from scratch.

5. **Cross-reference `build-from-issue`.** Mention it as the natural next step in the spike footer.

## Example Usage

### Feature spike

User says: "Add a Matrix channel as a bundled plugin"

1. Problem is clear — no clarification needed
2. Investigate the codebase:
   - Reads `src/channels/` for core channel implementation patterns
   - Reads `src/plugin-sdk/channel-contract.ts` for the channel plugin contract
   - Reads an existing bundled channel plugin for the implementation pattern
   - Maps the plugin registration, manifest, and onboarding flow
   - Reads `docs/plugins/sdk-channel-plugins.md` for channel plugin docs
   - Identifies exact insertion points: manifest, registration, message handling
   - Assesses: Medium complexity, High confidence, ~6 files
3. Write `docs/specs/MATRIX-CHANNEL-PLUGIN-SPIKE.md` — contains both the summary and full investigation (code references, architecture context, alternative approaches)
4. Report: "Wrote `docs/specs/MATRIX-CHANNEL-PLUGIN-SPIKE.md`. The investigation found that a Matrix channel can follow the same bundled plugin pattern as existing channels. The proposed approach adds a new workspace plugin package. Review the spike and use `build-from-issue` when ready."

### Bug investigation spike

User says: "The Discord webhook handler seems to drop messages when the gateway restarts"

1. Problem is clear enough — investigate message handling during gateway lifecycle
2. Investigate:
   - Reads the Discord channel implementation in `src/discord/`
   - Reads the gateway lifecycle and restart logic
   - Traces the webhook → message processing → reply pipeline
   - Identifies that in-flight messages are lost during graceful shutdown
   - Assesses: Low complexity, High confidence, ~2 files
3. Write `docs/specs/DISCORD-WEBHOOK-MESSAGE-LOSS-SPIKE.md`
4. Report: "Wrote `docs/specs/DISCORD-WEBHOOK-MESSAGE-LOSS-SPIKE.md`. In-flight messages are lost during gateway restart because the webhook handler doesn't drain pending work. Straightforward fix. Review and use `build-from-issue` when ready."

### Performance spike

User says: "Plugin loading is slow when there are many installed plugins"

1. Problem is clear — investigate plugin loading performance
2. Investigate:
   - Reads the plugin discovery and loading pipeline in `src/plugins/`
   - Traces the startup sequence from CLI → plugin registry → manifest validation → loader
   - Identifies that manifests are parsed sequentially with no caching
   - Assesses: Medium complexity, Medium confidence (cache invalidation is a design decision), ~4 files
3. Write `docs/specs/PLUGIN-LOADING-PERF-SPIKE.md`
4. Report: "Wrote `docs/specs/PLUGIN-LOADING-PERF-SPIKE.md`. Plugins are loaded sequentially with no manifest caching. The main design decision is the cache invalidation strategy — flagged as an open question. Review and use `build-from-issue` when ready."
