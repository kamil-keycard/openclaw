---
summary: "Mint a workload JWT from the macOS Keycard daemon and exchange it for opaque provider credentials so onboarding skips per-provider API-key prompts."
read_when:
  - You want OpenClaw to read provider credentials from Keycard instead of API-key prompts
  - You run OpenClaw on macOS and already have keycard-osx-oidcd installed
  - You are setting up Anthropic or OpenAI access for the gateway and want to avoid pasting API keys
  - You are debugging "missing API key" errors and suspect Keycard identity should cover the provider
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

## Diagnostics

Run `openclaw doctor` to validate the configuration:

- Reports the configured zone and provider mappings.
- Errors when `gateway.identity.keycard.zoneId` is set on a non-macOS host.
- Errors when the daemon socket cannot be found.
- `openclaw doctor --deep` additionally probes the Keycard zone's
  `/.well-known/oauth-authorization-server` endpoint and warns when
  discovery fails.

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
- Per-agent SPIFFE identities; this flow keeps the gateway as the single
  Keycard-aware component.
- Token-refresh hot-reload from Keycard policy changes; refresh runs on
  TTL expiry only.
- Replacing OAuth flows for Anthropic CLI / OpenAI Codex; those continue
  to coexist and Keycard is one more fallback in the resolver chain.
