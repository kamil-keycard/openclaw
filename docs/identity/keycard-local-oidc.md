---
summary: "Mint a workload JWT from the macOS Keycard daemon and exchange it for opaque provider credentials so onboarding skips per-provider API-key prompts."
read_when:
  - You want OpenClaw to read provider credentials from Keycard instead of API-key prompts
  - You run OpenClaw on macOS and already have keycard-osx-oidcd installed
  - You are setting up Anthropic or OpenAI access for the gateway and want to avoid pasting API keys
  - You are debugging "missing API key" errors and suspect Keycard identity should cover the provider
  - You are configuring per-agent keycard secret refs and need to know how the daemon's `--agent <id>` flag scopes the JWT
title: "Keycard local OIDC identity"
---

`gateway.identity.keycard` is an opt-in macOS-only flow that lets the gateway
mint a workload JWT from the local
[`keycard-osx-oidc`](https://github.com/keycard/keycard-osx-oidc) daemon,
exchange it with a Keycard zone for an opaque resource credential, and feed
that credential straight into the existing model-auth resolver. When a
provider is covered by Keycard, OpenClaw skips its API-key onboarding prompt
and the runtime resolves the secret on first model call.

## At a glance

- Configure a single `gateway.identity.keycard.zoneId`; built-in defaults
  cover Anthropic and OpenAI.
- Onboarding suppresses API-key prompts for any provider with a Keycard
  resource mapping; nothing is written to `auth-profiles.json`.
- The gateway mints tokens lazily on first model call. There is no startup
  prefetch.
- Off-macOS the feature is a no-op and falls back to legacy auth with a
  single warning log.

## Prerequisites

- macOS host (Phase 1 only supports Darwin; Linux/Windows fall back to
  legacy auth).
- The `keycard-osx-oidcd` daemon installed and running, with its Unix
  socket reachable at `/var/run/keycard-osx-oidcd.sock` (or a custom path
  supplied via `socketPath`).
- Resources provisioned in your Keycard zone. The default mapping expects
  `urn:secret:claude-api` for Anthropic and `urn:secret:openai-api` for
  OpenAI.

## Configuration

Add a `gateway.identity.keycard` block to your config:

```yaml
gateway:
  identity:
    keycard:
      zoneId: o36mbsre94s2vlt8x5jq6nbxs0
      # Optional overrides:
      # socketPath: /var/run/keycard-osx-oidcd.sock
      # audience: https://o36mbsre94s2vlt8x5jq6nbxs0.keycard.cloud/oauth/2/token
      # providers:
      #   anthropic:
      #     resource: urn:secret:claude-api
      #   openai:
      #     resource: urn:secret:openai-api
```

When only `zoneId` is set, OpenClaw layers in the built-in defaults so
Anthropic and OpenAI work without further configuration. Explicit
`providers.<id>.resource` entries always win and may use any RFC 8707
resource indicator (URL or URN).

### Onboarding flags

The `openclaw onboard` command accepts:

- `--keycard-zone-id <id>` — enable Keycard identity for the given zone.
- `--keycard-provider <provider=resource>` — repeatable; map a provider id
  to a Keycard resource. Built-in defaults are applied when this flag is
  omitted.

Example:

```bash
openclaw onboard --non-interactive --accept-risk \
  --keycard-zone-id o36mbsre94s2vlt8x5jq6nbxs0 \
  --keycard-provider anthropic=urn:secret:claude-api
```

## How resolution works

1. On first model call, `model-auth.ts` walks its existing resolver chain
   (auth profile, env vars, config markers).
2. If none of those match and a Keycard mapping covers the provider, the
   gateway-scoped Keycard resolver runs.
3. The resolver mints a JWT via the local daemon (audience defaults to the
   discovered token endpoint), then performs an RFC 6749
   `client_credentials` grant against the Keycard zone using an RFC 7523
   `client_assertion` and an RFC 8707 `resource` parameter.
4. The opaque `access_token` returned by Keycard is fed back into the
   provider call. OpenClaw treats it as the upstream credential without
   interpretation.

Tokens are cached in-process per resource and refreshed shortly before
expiry. Single-flight semantics prevent duplicate exchanges under load.

## Per-agent identity (`--agent <id>`)

OpenClaw can also use Keycard as a secret provider for individual agents
running inside the gateway. When the resolver is asked for a per-agent
credential it invokes `keycard-osx-oidcd --agent <id>`; the daemon mints
a JWT whose payload carries an extra `agent_id: <id>` claim. The gateway
exchanges that JWT against the Keycard zone the same way as the
gateway-shared token, so Keycard policy can scope each `urn:secret:*`
resource by `agent_id`.

Keys to be aware of:

- The daemon contract is fixed: passing `--agent <id>` MUST add an
  `agent_id` claim and leave every other claim unchanged. Older daemons
  that ignore the flag will mint the gateway-shared token; the
  `openclaw doctor --deep` per-agent probe surfaces this and warns that
  per-agent secret refs are falling back.
- Tokens are cached per `(audience, agentId)` inside OpenClaw. Exchanged
  access tokens are cached per `(resource, agentId)` with bounded LRU
  eviction so a long-running gateway with many agents stays within
  memory limits.
- v1 does **not** restrict which local processes can talk to the daemon
  socket; any process running as the same user can request a token for
  any `agentId` the gateway would itself ask for. Treat the gateway and
  the daemon as a single trust boundary until a future hardening pass
  adds peer authentication.

### Example Keycard policy

A policy that gates the per-agent resource on the `agent_id` claim might
look like the following (Keycard policy DSL — see your zone admin for
the exact syntax):

```text
allow exchange when claim.agent_id == "billing-bot"
  and resource == "urn:secret:billing-bot/openai"
allow exchange when claim.agent_id == "support-bot"
  and resource == "urn:secret:support-bot/openai"
```

The matching OpenClaw config wires per-agent secret refs into the
agent's `secrets.providers` and per-agent paths:

```yaml
secrets:
  providers:
    keycard: { source: keycard }
  defaults:
    keycard: keycard

agents:
  list:
    billing-bot:
      providers:
        openai:
          apiKey:
            $secret: keycard:keycard:urn:secret:billing-bot/openai
    support-bot:
      providers:
        openai:
          apiKey:
            $secret: keycard:keycard:urn:secret:support-bot/openai
```

Because the agent id lives in the config path
(`agents.list.<id>.providers.openai.apiKey`), the gateway derives the
`agent_id` claim automatically; callers may also pass an explicit
`agentId` to the `secrets.resolve` RPC to override.

## Diagnostics

Run `openclaw doctor` to validate the configuration:

- Reports the configured zone and provider mappings.
- Errors when `gateway.identity.keycard.zoneId` is set on a non-macOS host.
- Errors when the daemon socket cannot be found.
- `openclaw doctor --deep` additionally probes the Keycard zone's
  `/.well-known/oauth-authorization-server` endpoint and warns when
  discovery fails.
- `openclaw doctor --deep` runs an optional per-agent claim probe:
  it asks the daemon for a token with `--agent openclaw-doctor-probe`
  and verifies the resulting JWT carries the matching `agent_id` claim.
  When the probe fails the doctor emits a warning so per-agent secret
  refs are not silently routed to the gateway-shared identity.

## Skipped onboarding prompts

When a Keycard mapping covers a provider, the wizard:

- Notes "<Provider> credentials will be obtained from Keycard" with the
  resource URN and zone id.
- Skips the per-provider API-key prompt entirely.
- Writes no `auth-profiles.json` entry for the provider; runtime
  resolution mints on demand.

You can still pick the provider from the auth-choice menu — only the
key-collection step is suppressed.

## Out of scope

- Linux and Windows token sources (file, IRSA, etc.).
- Per-agent SPIFFE identities; per-agent tokens reuse the same daemon
  and zone, only adding the `agent_id` claim.
- Daemon-side trust boundary for the `--agent <id>` flag; v1 does not
  authenticate the calling process, so any local process running as the
  user can ask for a per-agent token.
- Token-refresh hot-reload from Keycard policy changes; refresh runs on
  TTL expiry only.
- Replacing OAuth flows for Anthropic CLI / OpenAI Codex; those continue
  to coexist and Keycard is one more fallback in the resolver chain.
