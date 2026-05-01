/**
 * Plugin-secret-source contracts.
 *
 * Plugins register a `SecretSourceFactory` via `api.registerSecretSource(...)`
 * (see `src/plugin-sdk/secret-source.ts`). At config-validation time, core
 * looks up the factory for each `secrets.providers.<alias>` entry whose
 * `source` is `"plugin"`, hands the factory the raw alias payload for
 * plugin-owned Zod validation, and binds the resulting `SecretSource`
 * instance to the alias. Hot-path resolution dispatches by alias.
 *
 * Core never imports plugin-internal modules. Anything plugin-specific
 * (token-exchange flows, identity acquisition, caching) lives in the plugin.
 */

import type { ZodType } from "zod";

/** A single resolved secret value, optionally tagged with an absolute expiry. */
export type SecretSourceOutcome =
  | {
      ok: true;
      value: string;
      /** Absolute time (`Date.now()` units, ms) when the value should be considered stale. */
      expiresAt?: number;
    }
  | {
      ok: false;
      reason: "not-found" | "unavailable" | "denied";
      message: string;
    };

/** Lightweight readiness probe. A successful `factory.create(...)` is itself an availability signal. */
export type SecretSourceAvailability = { ok: true } | { ok: false; message: string };

/**
 * Plugin-instantiated secret resolver bound to a single
 * `secrets.providers.<alias>` entry.
 */
export interface SecretSource {
  /** Factory name (the registered plugin id). */
  readonly name: string;
  /** Operator alias under `secrets.providers.<alias>` this instance is bound to. */
  readonly alias: string;
  /**
   * Resolve a batch of refs. Plugins that cannot batch must return one
   * outcome per input in input order.
   */
  resolve(refs: ReadonlyArray<{ id: string }>): Promise<ReadonlyArray<SecretSourceOutcome>>;
  /** Optional readiness/availability probe. */
  diagnose?(): Promise<SecretSourceAvailability>;
  /** Optional cleanup hook called when the alias is unbound (config reload). */
  dispose?(): Promise<void> | void;
}

/** Context handed to a `SecretSourceFactory.create(...)` call. */
export type SecretSourceContext = {
  /** The operator's alias for this instance. */
  alias: string;
  /**
   * Parsed `plugins.entries[<plugin>].config` for the same plugin, if any.
   * Plugins own this payload; core stores it as `unknown`.
   */
  pluginEntryConfig?: unknown;
};

/**
 * Factory contract registered by a plugin.
 *
 * - `name`: matches the `plugin` field on `secrets.providers.<alias>` entries.
 * - `configSchema`: validates the per-alias payload (open envelope around it
 *   is core-defined: `{ source: "plugin", plugin: name, ...this }`).
 * - `create`: build a `SecretSource` instance for an alias.
 */
export type SecretSourceFactory = {
  name: string;
  configSchema: ZodType<unknown>;
  create(parsed: unknown, ctx: SecretSourceContext): Promise<SecretSource> | SecretSource;
};
