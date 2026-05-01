/**
 * Plugin-secret-source registry — process-global singleton.
 *
 * Two layers:
 *   1. Factory map (`pluginName → SecretSourceFactory`) populated as plugins
 *      load and call `api.registerSecretSource(...)`.
 *   2. Alias-instance map (`alias → SecretSource`) populated during config
 *      validation when each `secrets.providers.<alias>` with
 *      `source: "plugin"` is bound to its factory.
 *
 * Mirrors the global-singleton pattern used by `compaction-provider.ts` and
 * `memory-embedding-providers.ts` so duplicated dist chunks share one map at
 * runtime.
 */

import type { SecretSource, SecretSourceFactory } from "./source-plugin.js";

const SECRET_SOURCE_REGISTRY_STATE = Symbol.for("openclaw.secretSourceRegistryState");

type RegisteredFactory = {
  factory: SecretSourceFactory;
  ownerPluginId?: string;
};

type RegisteredAlias = {
  source: SecretSource;
  factoryName: string;
};

type SecretSourceRegistryState = {
  factories: Map<string, RegisteredFactory>;
  aliases: Map<string, RegisteredAlias>;
};

function getRegistryState(): SecretSourceRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [SECRET_SOURCE_REGISTRY_STATE]?: SecretSourceRegistryState;
  };
  if (!globalState[SECRET_SOURCE_REGISTRY_STATE]) {
    globalState[SECRET_SOURCE_REGISTRY_STATE] = {
      factories: new Map<string, RegisteredFactory>(),
      aliases: new Map<string, RegisteredAlias>(),
    };
  }
  return globalState[SECRET_SOURCE_REGISTRY_STATE];
}

// ---------------------------------------------------------------------------
// Factory registration (plugin-load time)
// ---------------------------------------------------------------------------

export type RegisterSecretSourceResult =
  | { ok: true }
  | { ok: false; reason: "duplicate"; existingOwner?: string };

/**
 * Register a `SecretSourceFactory` under its `name`. Duplicate registrations
 * are rejected (callers should surface a diagnostic).
 */
export function registerSecretSourceFactory(
  factory: SecretSourceFactory,
  options?: { ownerPluginId?: string },
): RegisterSecretSourceResult {
  const state = getRegistryState();
  const existing = state.factories.get(factory.name);
  if (existing) {
    return {
      ok: false,
      reason: "duplicate",
      existingOwner: existing.ownerPluginId,
    };
  }
  state.factories.set(factory.name, {
    factory,
    ownerPluginId: options?.ownerPluginId,
  });
  return { ok: true };
}

export function lookupSecretSourceFactory(name: string): SecretSourceFactory | undefined {
  return getRegistryState().factories.get(name)?.factory;
}

/** Stable, alphabetical iteration order (per repo prompt-cache rules). */
export function listSecretSourceFactoryNames(): string[] {
  return [...getRegistryState().factories.keys()].toSorted();
}

// ---------------------------------------------------------------------------
// Alias binding (config-validation time)
// ---------------------------------------------------------------------------

/** Bind a `SecretSource` instance to an operator alias. Replaces any prior binding. */
export function bindSecretSourceAlias(params: {
  alias: string;
  source: SecretSource;
  factoryName: string;
}): void {
  const state = getRegistryState();
  const previous = state.aliases.get(params.alias);
  if (previous && previous.source !== params.source) {
    void runDispose(previous.source);
  }
  state.aliases.set(params.alias, {
    source: params.source,
    factoryName: params.factoryName,
  });
}

export type ResolveAliasResult =
  | { ok: true; source: SecretSource }
  | { ok: false; reason: "no-binding" };

export function resolveSecretSourceAlias(alias: string): ResolveAliasResult {
  const entry = getRegistryState().aliases.get(alias);
  if (!entry) {
    return { ok: false, reason: "no-binding" };
  }
  return { ok: true, source: entry.source };
}

/** Drop the binding for an alias. Calls `source.dispose()` if implemented. */
export function disposeSecretSourceAlias(alias: string): void {
  const state = getRegistryState();
  const entry = state.aliases.get(alias);
  if (!entry) {
    return;
  }
  state.aliases.delete(alias);
  void runDispose(entry.source);
}

/** Stable, alphabetical iteration order (per repo prompt-cache rules). */
export function listSecretSourceAliases(): string[] {
  return [...getRegistryState().aliases.keys()].toSorted();
}

// ---------------------------------------------------------------------------
// Lifecycle (clear / restore) — mirrors compaction-provider.ts
// ---------------------------------------------------------------------------

/** Clear all factory and alias registrations (used by reload paths). */
export function clearSecretSourceRegistry(): void {
  const state = getRegistryState();
  for (const entry of state.aliases.values()) {
    void runDispose(entry.source);
  }
  state.factories.clear();
  state.aliases.clear();
}

function runDispose(source: SecretSource): Promise<void> | void {
  if (typeof source.dispose !== "function") {
    return;
  }
  try {
    return source.dispose();
  } catch {
    // Plugin dispose failures are non-fatal; swallow and let the GC handle it.
  }
}
