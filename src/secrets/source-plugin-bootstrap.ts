/**
 * Plugin-secret-source bootstrap.
 *
 * Walks every `secrets.providers.<alias>` entry whose `source` is `"plugin"`,
 * looks up the registered factory, hands the factory the raw payload for
 * plugin-owned Zod validation, and binds the resulting `SecretSource` to the
 * alias.
 *
 * Callers run this after plugins finish registering and before any code path
 * resolves plugin-sourced refs. Failures are reported as diagnostics so a
 * single misconfigured alias does not bring down the gateway; references to
 * an unbound alias resolve as a tagged provider-resolution error at request
 * time.
 */

import type { OpenClawConfig } from "./../config/types.openclaw.js";
import type { PluginSecretProviderConfig } from "./../config/types.secrets.js";
import { formatErrorMessage } from "./../infra/errors.js";
import {
  bindSecretSourceAlias,
  disposeSecretSourceAlias,
  listSecretSourceAliases,
  lookupSecretSourceFactory,
} from "./source-plugin-registry.js";

export type PluginSecretSourceBootstrapDiagnostic = {
  level: "warn" | "error";
  alias: string;
  pluginName?: string;
  message: string;
  cause?: unknown;
};

export type PluginSecretSourceBootstrapResult = {
  bound: string[];
  diagnostics: PluginSecretSourceBootstrapDiagnostic[];
};

export type PluginSecretSourceBootstrapOptions = {
  /**
   * Optional resolver for `plugins.entries[<plugin>].config` so the factory
   * sees plugin-entry context when it builds an alias instance.
   */
  pluginEntryConfig?: (pluginName: string) => unknown;
  /**
   * When `true`, run `source.diagnose()` (if implemented) and warn-and-skip
   * on `{ ok: false }`. Defaults to `true`; tests that bypass diagnostics
   * pass `false`.
   */
  runDiagnose?: boolean;
};

/**
 * Bootstrap plugin-source aliases from config. Returns a list of bound
 * aliases and a diagnostic stream the caller should surface. Idempotent:
 * aliases that disappear from config are unbound; aliases that change
 * factories are rebound.
 */
export async function bootstrapPluginSecretSources(
  config: OpenClawConfig,
  options: PluginSecretSourceBootstrapOptions = {},
): Promise<PluginSecretSourceBootstrapResult> {
  const diagnostics: PluginSecretSourceBootstrapDiagnostic[] = [];
  const bound: string[] = [];
  const seen = new Set<string>();

  const providers = config.secrets?.providers ?? {};
  // Stable, alphabetical iteration order (per repo prompt-cache rules).
  const aliases = Object.keys(providers).toSorted();

  for (const alias of aliases) {
    const providerConfig = providers[alias];
    if (!providerConfig || providerConfig.source !== "plugin") {
      continue;
    }
    seen.add(alias);

    const pluginName = (providerConfig as PluginSecretProviderConfig).plugin;
    const factory = lookupSecretSourceFactory(pluginName);
    if (!factory) {
      disposeSecretSourceAlias(alias);
      diagnostics.push({
        level: "warn",
        alias,
        pluginName,
        message: `secrets.providers.${alias}: no plugin secret source registered for "${pluginName}"; references will fail to resolve.`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = factory.configSchema.parse(providerConfig);
    } catch (err) {
      disposeSecretSourceAlias(alias);
      diagnostics.push({
        level: "error",
        alias,
        pluginName,
        message: `secrets.providers.${alias}: plugin "${pluginName}" rejected the alias config: ${formatErrorMessage(err)}`,
        cause: err,
      });
      continue;
    }

    const pluginEntryConfig = options.pluginEntryConfig?.(pluginName);
    let source;
    try {
      source = await factory.create(parsed, {
        alias,
        pluginEntryConfig,
      });
    } catch (err) {
      disposeSecretSourceAlias(alias);
      diagnostics.push({
        level: "error",
        alias,
        pluginName,
        message: `secrets.providers.${alias}: plugin "${pluginName}" failed to create source: ${formatErrorMessage(err)}`,
        cause: err,
      });
      continue;
    }

    if ((options.runDiagnose ?? true) && typeof source.diagnose === "function") {
      try {
        const availability = await source.diagnose();
        if (!availability.ok) {
          disposeSecretSourceAlias(alias);
          diagnostics.push({
            level: "warn",
            alias,
            pluginName,
            message: `secrets.providers.${alias}: plugin "${pluginName}" reported unavailable: ${availability.message}`,
          });
          continue;
        }
      } catch (err) {
        disposeSecretSourceAlias(alias);
        diagnostics.push({
          level: "warn",
          alias,
          pluginName,
          message: `secrets.providers.${alias}: plugin "${pluginName}" diagnose() threw: ${formatErrorMessage(err)}`,
          cause: err,
        });
        continue;
      }
    }

    bindSecretSourceAlias({
      alias,
      source,
      factoryName: factory.name,
    });
    bound.push(alias);
  }

  // Unbind aliases that disappeared from config since the last bootstrap.
  for (const alias of listSecretSourceAliases()) {
    if (!seen.has(alias)) {
      disposeSecretSourceAlias(alias);
    }
  }

  return { bound, diagnostics };
}
