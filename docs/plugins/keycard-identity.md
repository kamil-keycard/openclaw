---
summary: "Keycard Identity plugin: resolve SecretRefs via Keycard zones using workload-identity federation, client credentials, or private-key JWT"
read_when:
  - You want the OpenClaw gateway to fetch model API keys (or any other SecretRef-shaped field) from a Keycard zone
  - You want per-resource token lifetimes and refresh without pasting long-lived keys into config
  - You are configuring workload-identity federation, client-credentials, or private-key JWT as the gateway's identity method
title: "Keycard Identity plugin"
---

The `keycard-identity` plugin is the first concrete plugin-sourced secret
provider. It registers a `SecretSource` named `keycard-identity` via the
[`openclaw/plugin-sdk/secret-source`](/plugins/sdk-entrypoints#openclaw-plugin-sdk-secret-source)
entrypoint. Any `SecretRef` whose `source` is `"plugin"` and whose
`provider` names an alias bound to this plugin resolves through it.

At request time the plugin:

1. Acquires an identity assertion for the gateway (workload-identity
   daemon, token file, client credentials, or private-key JWT).
2. Performs RFC 8414 discovery against the configured Keycard zone.
3. Exchanges the assertion for a resource-scoped access token via
   RFC 8693 token exchange (including RFC 8707 resource indicators).
4. Caches the resulting token per `(alias, id)` with its reported
   `expires_in`, refreshing lazily when within the TTL leeway.

## Install and enable

```bash
openclaw plugins install @openclaw/keycard-identity
openclaw plugins enable keycard-identity
```

The plugin is not `enabledByDefault`. Operators opt in explicitly.

## Operator config

Two layers of config:

1. **Plugin entry** — `plugins.entries["keycard-identity"].config` carries
   the gateway's single `(zoneId, identity-method)` registration. One
   gateway, one identity.
2. **Per alias** — `secrets.providers.<alias>` with
   `source: "plugin"` / `plugin: "keycard-identity"` exposes a resource
   catalog backed by that identity.

```json
{
  "plugins": {
    "entries": {
      "keycard-identity": {
        "enabled": true,
        "config": {
          "identity": {
            "zoneId": "zone_abc123",
            "method": {
              "kind": "workload-identity",
              "source": { "type": "macos-daemon" }
            }
          }
        }
      }
    }
  },
  "secrets": {
    "providers": {
      "keycard": {
        "source": "plugin",
        "plugin": "keycard-identity",
        "resources": {
          "anthropic-api-key": { "resource": "https://api.anthropic.com" },
          "openai-api-key": { "resource": "https://api.openai.com" },
          "telegram-bot": { "resource": "https://api.telegram.org" }
        }
      }
    }
  },
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "https://api.anthropic.com",
        "api": "anthropic-messages",
        "auth": "api-key",
        "apiKey": { "source": "plugin", "provider": "keycard", "id": "anthropic-api-key" },
        "models": [
          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" },
          { "id": "claude-opus-4-6", "name": "Claude Opus 4.6" },
          { "id": "claude-opus-4-7", "name": "Claude Opus 4.7" }
        ]
      }
    }
  },
  "channels": {
    "telegram": {
      "botToken": { "source": "plugin", "provider": "keycard", "id": "telegram-bot" }
    }
  }
}
```

## Identity methods

The `identity.method` discriminator is plugin-internal. Swap it without
touching any other config.

### Workload identity

```json
{
  "kind": "workload-identity",
  "source": { "type": "macos-daemon", "socketPath": "/var/run/keycard-osx-oidcd.sock" }
}
```

Sources (`source.type`):

- `macos-daemon` — talks to the `keycard-osx-oidcd` daemon over a UDS.
  Default socket `/var/run/keycard-osx-oidcd.sock`. The daemon binds
  identity to the caller's UID via `getpeereid()`.
- `token-file` — reads a pre-signed JWT from disk. Pair with an external
  watcher that keeps the file fresh.
- `spiffe` — declared for future use; not implemented in this release.
- `static-test` — inline token; tests only.

### Client credentials

```json
{
  "kind": "client-credentials",
  "clientId": "svc_gateway",
  "clientSecret": { "source": "env", "provider": "default", "id": "KEYCARD_GATEWAY_SECRET" }
}
```

`clientSecret` is a `SecretRef` resolved through the standard secret
pipeline (`env` / `file` / `exec`). The plugin presents it as HTTP Basic
auth on the token endpoint.

### Private-key JWT (RFC 7523)

```json
{
  "kind": "private-key-jwt",
  "clientId": "svc_gateway",
  "keyId": "k1",
  "privateKey": { "source": "file", "provider": "mounted", "id": "/keys/gateway.pem" },
  "signingAlg": "RS256"
}
```

`privateKey` resolves to a PKCS#8 PEM-encoded private key. Supported
algorithms: `RS256` (default), `ES256`.

## Resource catalog

Each alias under `secrets.providers.<alias>` carries a `resources` map
from the operator's `id` key to exchange parameters:

```json
{
  "resources": {
    "anthropic-api-key": {
      "resource": "https://api.anthropic.com",
      "audience": "https://api.anthropic.com",
      "scopes": ["inference:write"]
    }
  }
}
```

- `resource` — required. RFC 8707 resource URI on the exchange request.
- `audience` — optional RFC 8693 audience override.
- `scopes` — optional OAuth scope list joined into the `scope` parameter.

`SecretRef.id` in any downstream field looks up this catalog by key.

## TTL and refresh

Tokens returned by the exchange carry `expires_in`. The plugin caches
each token with its absolute `expiresAt` and refreshes lazily when within
the `tokenRefreshSkewMs` window of expiry (default 60 s). Concurrent
resolves for the same id coalesce through single-flight so a burst hits
the zone once.

Identity assertions (workload-identity JWTs) are cached similarly when
their reported `expiresAt` is present.

## Diagnostics

`diagnose()` probes RFC 8414 discovery against the configured zone. A
misconfigured `zoneId`, offline issuer, or unreachable network surfaces
as a tagged `{ ok: false, message }` during bootstrap and the alias is
left unbound; references resolve as a `not-found` provider error at
request time so the rest of the config keeps working.

## Known gaps (Phase 2)

- Gateway-startup wiring for `bootstrapPluginSecretSources` is not
  landed yet. Tests drive the bootstrap helper directly today.
- SPIFFE workload-identity source is declared in the schema but throws
  at acquisition time until the SVID protocol is implemented.
- SecretRef resolution inside identity methods (`client-credentials`
  `clientSecret`, `private-key-jwt` `privateKey`) needs a resolver
  injected by the host. The plugin-owned resolver wiring lands alongside
  the gateway bootstrap call-site.
