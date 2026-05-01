export type PluginSecretRefMeta = {
  /** Absolute expiry (`Date.now()` units, ms) reported by the plugin source, if any. */
  expiresAt?: number;
  /** Wall-clock time when the value was resolved into the cache. */
  resolvedAt: number;
};

export type SecretRefResolveCache = {
  resolvedByRefKey?: Map<string, Promise<unknown>>;
  filePayloadByProvider?: Map<string, Promise<unknown>>;
  /**
   * Per-ref metadata for plugin-sourced values. Populated only for refs
   * resolved through a plugin secret source. The snapshot layer reads this
   * to drive TTL-aware refresh.
   */
  pluginRefMetaByRefKey?: Map<string, PluginSecretRefMeta>;
};
