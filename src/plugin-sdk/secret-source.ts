/**
 * Plugin SDK entrypoint for plugin-secret-source authors.
 *
 * Plugins call `api.registerSecretSource(factory)` from their `register(api)`
 * function to contribute resolution for `secrets.providers.<alias>` entries
 * with `source: "plugin"`.
 *
 * Core never imports plugin internals. Anything plugin-specific (token
 * exchange, identity acquisition, caching, retries) lives in the plugin.
 *
 * Example:
 *
 * ```ts
 * import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
 * import type { SecretSourceFactory } from "openclaw/plugin-sdk/secret-source";
 *
 * const factory: SecretSourceFactory = {
 *   name: "my-issuer",
 *   configSchema: myAliasSchema,
 *   create: createMySource,
 * };
 *
 * export default definePluginEntry({
 *   id: "my-issuer",
 *   name: "My Issuer",
 *   description: "Resolves SecretRefs via my-issuer",
 *   register(api) {
 *     api.registerSecretSource(factory);
 *   },
 * });
 * ```
 */

export type {
  SecretSource,
  SecretSourceAvailability,
  SecretSourceContext,
  SecretSourceFactory,
  SecretSourceOutcome,
} from "../secrets/source-plugin.js";
