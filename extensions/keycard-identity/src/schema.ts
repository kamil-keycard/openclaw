/**
 * Plugin-owned Zod schemas for the Keycard identity plugin.
 *
 * Two layers of config:
 *
 *   1. `plugins.entries["keycard-identity"].config` — the gateway's single
 *      `(zoneId, identity-method)` registration. Validated by
 *      `KeycardPluginConfigSchema`.
 *   2. `secrets.providers.<alias>` — the resource catalog backing this alias.
 *      Validated by `KeycardAliasConfigSchema`. Core pre-parses the envelope
 *      (`source: "plugin"`, `plugin: string`) and hands the full object to
 *      this schema.
 *
 * All schemas are plugin-owned. Core never imports them; it only calls
 * `factory.configSchema.parse(...)` through `api.registerSecretSource(...)`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// SecretRef — duplicated from core so the plugin stays build-contained and
// can validate `clientSecret` / `privateKey` embedded in its own payload.
// Schema mirrors the core allowlist of sources.
// ---------------------------------------------------------------------------

const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_SECRET_REF_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

const providerAliasSchema = z
  .string()
  .regex(
    SECRET_PROVIDER_ALIAS_PATTERN,
    "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/.",
  );

const secretRefSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("env"),
    provider: providerAliasSchema,
    id: z.string().regex(ENV_SECRET_REF_ID_PATTERN),
  }),
  z.object({
    source: z.literal("file"),
    provider: providerAliasSchema,
    id: z.string().min(1),
  }),
  z.object({
    source: z.literal("exec"),
    provider: providerAliasSchema,
    id: z.string().min(1),
  }),
]);

// ---------------------------------------------------------------------------
// Workload-identity sources
// ---------------------------------------------------------------------------

const workloadIdentityMacosDaemonSchema = z
  .object({
    type: z.literal("macos-daemon"),
    /** Unix socket path; defaults to `/var/run/keycard-osx-oidcd.sock`. */
    socketPath: z.string().min(1).optional(),
    /** Timeout for a single UDS round-trip. Defaults to 5s. */
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

const workloadIdentityTokenFileSchema = z
  .object({
    type: z.literal("token-file"),
    path: z.string().min(1),
    /** How often to re-read the file. Defaults to 60s. */
    refreshIntervalSec: z.number().int().positive().max(86_400).optional(),
  })
  .strict();

const workloadIdentitySpiffeSchema = z
  .object({
    type: z.literal("spiffe"),
    socketPath: z.string().min(1).optional(),
  })
  .strict();

const workloadIdentityStaticTestSchema = z
  .object({
    type: z.literal("static-test"),
    /** A pre-signed JWT. Test harness only. */
    token: z.string().min(1),
    /** Optional absolute expiry (`Date.now()` ms) for the token. */
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();

const workloadIdentitySourceSchema = z.discriminatedUnion("type", [
  workloadIdentityMacosDaemonSchema,
  workloadIdentityTokenFileSchema,
  workloadIdentitySpiffeSchema,
  workloadIdentityStaticTestSchema,
]);

// ---------------------------------------------------------------------------
// Identity methods
// ---------------------------------------------------------------------------

const workloadIdentityMethodSchema = z
  .object({
    kind: z.literal("workload-identity"),
    source: workloadIdentitySourceSchema,
  })
  .strict();

const clientCredentialsMethodSchema = z
  .object({
    kind: z.literal("client-credentials"),
    clientId: z.string().min(1),
    clientSecret: secretRefSchema,
  })
  .strict();

const privateKeyJwtMethodSchema = z
  .object({
    kind: z.literal("private-key-jwt"),
    clientId: z.string().min(1),
    keyId: z.string().min(1),
    /** SecretRef resolving to a PKCS#8 PEM-encoded private key. */
    privateKey: secretRefSchema,
    signingAlg: z.enum(["RS256", "ES256"]).optional(),
  })
  .strict();

export const KeycardIdentityMethodSchema = z.discriminatedUnion("kind", [
  workloadIdentityMethodSchema,
  clientCredentialsMethodSchema,
  privateKeyJwtMethodSchema,
]);

// ---------------------------------------------------------------------------
// Plugin-entry config
// ---------------------------------------------------------------------------

export const KeycardPluginConfigSchema = z
  .object({
    /** The gateway's single registration at a Keycard zone plus the method it uses. */
    identity: z
      .object({
        /** The Keycard zone id (issuer / authorization server). */
        zoneId: z.string().min(1),
        /** How the gateway proves its identity to the zone. */
        method: KeycardIdentityMethodSchema,
        /**
         * Optional explicit issuer URL. When omitted the plugin derives
         * `https://<zoneId>.keycard.cloud` as the default for RFC 8414
         * discovery.
         */
        issuer: z.string().url().optional(),
      })
      .strict(),
  })
  .strict();

export type KeycardPluginConfig = z.infer<typeof KeycardPluginConfigSchema>;
export type KeycardIdentityMethod = z.infer<typeof KeycardIdentityMethodSchema>;

// ---------------------------------------------------------------------------
// Per-alias config
// ---------------------------------------------------------------------------

const keycardResourceEntrySchema = z
  .object({
    /** RFC 8707 resource URI requested at exchange time. */
    resource: z.string().url(),
    /** Optional RFC 8693 audience. */
    audience: z.string().min(1).optional(),
    /** Optional OAuth scopes. */
    scopes: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict();

export const KeycardAliasConfigSchema = z
  .object({
    source: z.literal("plugin"),
    plugin: z.literal("keycard-identity"),
    /** `id` → exchange parameters catalog used by `SecretRef.id` lookups. */
    resources: z.record(z.string().min(1), keycardResourceEntrySchema),
    /**
     * Optional per-alias identity override. When absent the factory uses the
     * plugin-entry identity. This is mostly a test seam — typical operator
     * configs keep identity on the plugin entry and only declare resources
     * here.
     */
    identity: KeycardPluginConfigSchema.shape.identity.optional(),
  })
  .strict();

export type KeycardAliasConfig = z.infer<typeof KeycardAliasConfigSchema>;
export type KeycardResourceEntry = z.infer<typeof keycardResourceEntrySchema>;
