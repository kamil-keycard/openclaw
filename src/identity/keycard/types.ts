/**
 * Keycard identity types shared across the resolver, gateway startup wiring,
 * onboarding prompts, and doctor diagnostics.
 */

export type KeycardProviderEntry = {
  /** RFC 8707 resource indicator (URL or URN, e.g. `urn:secret:claude-api`). */
  resource: string;
};

export type KeycardIdentityConfig = {
  zoneId: string;
  /** Optional override for the daemon socket path (diagnostic only — the CLI uses the default). */
  socketPath?: string;
  /** Optional override for the JWT audience (defaults to the discovered token endpoint). */
  audience?: string;
  /**
   * Optional explicit per-provider mapping. Built-in defaults are layered in
   * by `effectiveProviderMappings` for `anthropic` and `openai` when missing.
   */
  providers?: Record<string, KeycardProviderEntry>;
};

/**
 * Default per-provider Keycard resource mapping. Operators who only configure
 * `gateway.identity.keycard.zoneId` get these for free.
 */
export const DEFAULT_KEYCARD_PROVIDER_RESOURCES: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "urn:secret:claude-api",
  openai: "urn:secret:openai-api",
});

/**
 * Resolve the effective provider→resource mapping by layering explicit config
 * over the built-in defaults. Explicit entries always win.
 */
export function effectiveProviderMappings(
  identity: Pick<KeycardIdentityConfig, "providers"> | undefined,
): Record<string, KeycardProviderEntry> {
  const result: Record<string, KeycardProviderEntry> = {};
  for (const [provider, resource] of Object.entries(DEFAULT_KEYCARD_PROVIDER_RESOURCES)) {
    result[provider] = { resource };
  }
  for (const [provider, entry] of Object.entries(identity?.providers ?? {})) {
    if (entry?.resource && entry.resource.trim().length > 0) {
      result[provider] = { resource: entry.resource };
    }
  }
  return result;
}

/**
 * Returns the Keycard resource configured (or defaulted) for a given
 * provider id, or `undefined` if no mapping applies.
 */
export function resolveKeycardResourceForProvider(
  identity: KeycardIdentityConfig | undefined,
  provider: string,
): string | undefined {
  if (!identity) {
    return undefined;
  }
  const mappings = effectiveProviderMappings(identity);
  return mappings[provider]?.resource;
}
