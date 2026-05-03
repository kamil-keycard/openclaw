/**
 * Keycard `SecretSource` implementation.
 *
 * Binds one operator alias (`secrets.providers.<alias>`) to a Keycard zone
 * and resolves `SecretRef.id` values by:
 *
 *   1. Mapping `id` to a `KeycardResourceEntry` (the plugin-owned catalog
 *      declared under the alias).
 *   2. Acquiring an identity assertion for the gateway's configured
 *      identity method (cached while still fresh).
 *   3. RFC 8414 discovery of the token endpoint (cached for the life of
 *      the source instance).
 *   4. Client credentials grant (RFC 6749 §4.4) with a JWT-bearer client
 *      assertion (RFC 7523) and RFC 8707 resource indicator. Responses are
 *      cached per resource id with their reported `expires_in` and coalesced
 *      via single-flight so a concurrent burst hits the issuer once.
 */

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SecretSource,
  SecretSourceAvailability,
  SecretSourceContext,
  SecretSourceFactory,
  SecretSourceOutcome,
} from "openclaw/plugin-sdk/secret-source";
import {
  discoverAuthorizationServer,
  performTokenExchange,
  TokenExchangeError,
  type AuthorizationServerMetadata,
  type TokenExchangeFetch,
} from "./exchange.js";
import {
  acquireClientAssertion,
  type ClientAssertion,
  type IdentityAcquisitionEnv,
} from "./identity.js";
import {
  KeycardAliasConfigSchema,
  KeycardPluginConfigSchema,
  type KeycardAliasConfig,
  type KeycardIdentityMethod,
  type KeycardPluginConfig,
  type KeycardResourceEntry,
} from "./schema.js";

/** Default skew before a cached token's `expiresAt` triggers re-exchange. */
export const DEFAULT_TOKEN_REFRESH_SKEW_MS = 60_000;
/** Default skew before a cached identity assertion triggers re-acquisition. */
export const DEFAULT_ASSERTION_REFRESH_SKEW_MS = 30_000;

export type KeycardSourceFactoryOptions = {
  /**
   * Parsed plugin-entry config (`plugins.entries["keycard-identity"].config`).
   * May be omitted when every alias declares its own `identity` override.
   */
  pluginConfig?: KeycardPluginConfig;
  /** Optional plugin logger for diagnostics. */
  logger?: PluginLogger;
  /** Test seam: override `fetch` used for RFC 8414 / 8693 calls. */
  fetchImpl?: TokenExchangeFetch;
  /** Test seam: identity acquisition environment (UDS, token-file, secret-ref resolver). */
  identityEnv?: IdentityAcquisitionEnv;
  /** Override now() for deterministic tests. */
  now?: () => number;
  /**
   * Override the token refresh skew window. Tokens whose `expires_at` is
   * within this many ms of `now()` are refreshed on next access.
   */
  tokenRefreshSkewMs?: number;
  /** Override the assertion-cache refresh skew window (see above). */
  assertionRefreshSkewMs?: number;
};

type CachedTokenEntry = {
  value: string;
  /** Server-reported absolute expiry — returned to core in `SecretSourceOutcome`. */
  wireExpiresAt?: number;
  /** Effective absolute expiry used for staleness checks (may be config-overridden). */
  cacheExpiresAt?: number;
  resolvedAt: number;
};

type CachedAssertion = {
  assertion: ClientAssertion;
  expiresAt?: number;
};

export function createKeycardSecretSourceFactory(
  options: KeycardSourceFactoryOptions = {},
): SecretSourceFactory {
  return {
    name: "keycard-identity",
    configSchema: KeycardAliasConfigSchema,
    async create(parsed, ctx) {
      const alias = ctx.alias;
      const parsedAlias = parsed as KeycardAliasConfig;
      const identityConfig = resolveIdentityConfig({
        alias,
        aliasConfig: parsedAlias,
        pluginConfig: options.pluginConfig,
        ctxPluginEntryConfig: ctx.pluginEntryConfig,
      });
      return new KeycardSecretSource({
        alias,
        identityConfig,
        resources: parsedAlias.resources,
        defaultCacheTtlSec: parsedAlias.defaultCacheTtlSec,
        logger: options.logger,
        fetchImpl: options.fetchImpl,
        identityEnv: options.identityEnv,
        now: options.now,
        tokenRefreshSkewMs: options.tokenRefreshSkewMs,
        assertionRefreshSkewMs: options.assertionRefreshSkewMs,
      });
    },
  };
}

type ResolvedIdentityConfig = {
  zoneId: string;
  issuer: string;
  method: KeycardIdentityMethod;
};

function resolveIdentityConfig(params: {
  alias: string;
  aliasConfig: KeycardAliasConfig;
  pluginConfig?: KeycardPluginConfig;
  ctxPluginEntryConfig?: unknown;
}): ResolvedIdentityConfig {
  const aliasOverride = params.aliasConfig.identity;
  if (aliasOverride) {
    return {
      zoneId: aliasOverride.zoneId,
      issuer: aliasOverride.issuer ?? defaultKeycardIssuer(aliasOverride.zoneId),
      method: aliasOverride.method,
    };
  }
  const ctxConfig = parsePluginEntryConfig(params.ctxPluginEntryConfig);
  const pluginConfig = ctxConfig ?? params.pluginConfig;
  if (!pluginConfig) {
    throw new Error(
      `secrets.providers.${params.alias}: no identity configured. Declare plugins.entries["keycard-identity"].config.identity or add an alias-level identity override.`,
    );
  }
  return {
    zoneId: pluginConfig.identity.zoneId,
    issuer: pluginConfig.identity.issuer ?? defaultKeycardIssuer(pluginConfig.identity.zoneId),
    method: pluginConfig.identity.method,
  };
}

function parsePluginEntryConfig(value: unknown): KeycardPluginConfig | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = KeycardPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

export function defaultKeycardIssuer(zoneId: string): string {
  return `https://${zoneId}.keycard.cloud`;
}

// ---------------------------------------------------------------------------
// SecretSource implementation
// ---------------------------------------------------------------------------

type KeycardSecretSourceOptions = {
  alias: string;
  identityConfig: ResolvedIdentityConfig;
  resources: Record<string, KeycardResourceEntry>;
  /** Alias-level default cache TTL (seconds). Per-resource `cacheTtlSec` wins. */
  defaultCacheTtlSec?: number;
  logger?: PluginLogger;
  fetchImpl?: TokenExchangeFetch;
  identityEnv?: IdentityAcquisitionEnv;
  now?: () => number;
  tokenRefreshSkewMs?: number;
  assertionRefreshSkewMs?: number;
};

export class KeycardSecretSource implements SecretSource {
  readonly name = "keycard-identity";
  readonly alias: string;

  readonly #identityConfig: ResolvedIdentityConfig;
  readonly #resources: Record<string, KeycardResourceEntry>;
  readonly #defaultCacheTtlSec?: number;
  readonly #logger?: PluginLogger;
  readonly #fetchImpl: TokenExchangeFetch;
  readonly #identityEnv: IdentityAcquisitionEnv;
  readonly #now: () => number;
  readonly #tokenRefreshSkewMs: number;
  readonly #assertionRefreshSkewMs: number;

  #metadataPromise?: Promise<AuthorizationServerMetadata>;
  #assertionCache?: CachedAssertion;
  #assertionInFlight?: Promise<ClientAssertion>;
  readonly #tokenCache = new Map<string, CachedTokenEntry>();
  readonly #tokenInFlight = new Map<string, Promise<SecretSourceOutcome>>();

  constructor(opts: KeycardSecretSourceOptions) {
    this.alias = opts.alias;
    this.#identityConfig = opts.identityConfig;
    this.#resources = opts.resources;
    this.#defaultCacheTtlSec = opts.defaultCacheTtlSec;
    if (opts.logger) {
      this.#logger = opts.logger;
    }
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    this.#identityEnv = opts.identityEnv ?? {};
    this.#now = opts.now ?? Date.now;
    this.#tokenRefreshSkewMs = opts.tokenRefreshSkewMs ?? DEFAULT_TOKEN_REFRESH_SKEW_MS;
    this.#assertionRefreshSkewMs = opts.assertionRefreshSkewMs ?? DEFAULT_ASSERTION_REFRESH_SKEW_MS;
  }

  async resolve(refs: ReadonlyArray<{ id: string }>): Promise<ReadonlyArray<SecretSourceOutcome>> {
    return await Promise.all(refs.map((ref) => this.#resolveOne(ref.id)));
  }

  async diagnose(): Promise<SecretSourceAvailability> {
    try {
      await this.#getAuthorizationServerMetadata();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: `Keycard discovery failed for zone ${this.#identityConfig.zoneId}: ${formatError(err)}`,
      };
    }
  }

  async #resolveOne(id: string): Promise<SecretSourceOutcome> {
    const resource = this.#resources[id];
    if (!resource) {
      return {
        ok: false,
        reason: "not-found",
        message: `alias "${this.alias}" has no resource entry for id "${id}"`,
      };
    }

    const cached = this.#tokenCache.get(id);
    if (cached && !this.#isTokenStale(cached)) {
      return {
        ok: true,
        value: cached.value,
        ...(cached.wireExpiresAt ? { expiresAt: cached.wireExpiresAt } : {}),
      };
    }

    const existing = this.#tokenInFlight.get(id);
    if (existing) {
      return await existing;
    }
    const exchange = this.#exchangeForResource(id, resource);
    this.#tokenInFlight.set(id, exchange);
    try {
      return await exchange;
    } finally {
      this.#tokenInFlight.delete(id);
    }
  }

  async #exchangeForResource(
    id: string,
    resource: KeycardResourceEntry,
  ): Promise<SecretSourceOutcome> {
    try {
      const metadata = await this.#getAuthorizationServerMetadata();
      const assertion = await this.#getAssertion(metadata);
      const response = await performTokenExchange(
        {
          tokenEndpoint: metadata.token_endpoint,
          assertion,
          resource: resource.resource,
          ...(resource.scopes ? { scopes: [...resource.scopes] } : {}),
          now: this.#now,
        },
        this.#fetchImpl,
      );
      const now = this.#now();
      const configTtlSec = resource.cacheTtlSec ?? this.#defaultCacheTtlSec;
      const entry: CachedTokenEntry = {
        value: response.accessToken,
        resolvedAt: now,
      };
      if (typeof response.expiresAt === "number") {
        entry.wireExpiresAt = response.expiresAt;
      }
      entry.cacheExpiresAt =
        typeof configTtlSec === "number" ? now + configTtlSec * 1_000 : entry.wireExpiresAt;
      this.#tokenCache.set(id, entry);
      return {
        ok: true,
        value: entry.value,
        ...(entry.wireExpiresAt ? { expiresAt: entry.wireExpiresAt } : {}),
      };
    } catch (err) {
      const reason = classifyReason(err);
      this.#logger?.warn?.(
        `[keycard-identity] alias="${this.alias}" id="${id}" ${reason}: ${formatError(err)}`,
      );
      return { ok: false, reason, message: formatError(err) };
    }
  }

  async #getAuthorizationServerMetadata(): Promise<AuthorizationServerMetadata> {
    if (!this.#metadataPromise) {
      this.#metadataPromise = discoverAuthorizationServer(
        this.#identityConfig.issuer,
        this.#fetchImpl,
      ).catch((err) => {
        // Allow re-discovery on next access after a failure.
        this.#metadataPromise = undefined;
        throw err;
      });
    }
    return await this.#metadataPromise;
  }

  async #getAssertion(metadata: AuthorizationServerMetadata): Promise<ClientAssertion> {
    if (this.#assertionCache && !this.#isAssertionStale(this.#assertionCache.expiresAt)) {
      return this.#assertionCache.assertion;
    }
    if (this.#assertionInFlight) {
      return await this.#assertionInFlight;
    }
    const acquisition = acquireClientAssertion(
      this.#identityConfig.method,
      {
        tokenEndpoint: metadata.token_endpoint,
        issuer: metadata.issuer,
        clientIdForAssertion: clientIdForAssertion(this.#identityConfig),
      },
      { now: this.#now, ...this.#identityEnv },
    );
    this.#assertionInFlight = acquisition;
    try {
      const assertion = await acquisition;
      const entry: CachedAssertion = { assertion };
      if (assertion.kind === "jwt-bearer" && typeof assertion.expiresAt === "number") {
        entry.expiresAt = assertion.expiresAt;
      }
      this.#assertionCache = entry;
      return assertion;
    } finally {
      this.#assertionInFlight = undefined;
    }
  }

  #isTokenStale(cached: CachedTokenEntry): boolean {
    if (typeof cached.cacheExpiresAt !== "number") {
      return false;
    }
    const ttlMs = cached.cacheExpiresAt - cached.resolvedAt;
    const skew = Math.min(this.#tokenRefreshSkewMs, Math.max(1_000, Math.floor(ttlMs / 3)));
    return this.#now() >= cached.cacheExpiresAt - skew;
  }

  #isAssertionStale(expiresAt?: number): boolean {
    if (typeof expiresAt !== "number") {
      return false;
    }
    return this.#now() >= expiresAt - this.#assertionRefreshSkewMs;
  }
}

function clientIdForAssertion(id: ResolvedIdentityConfig): string {
  if (id.method.kind === "client-credentials" || id.method.kind === "private-key-jwt") {
    return id.method.clientId;
  }
  return id.zoneId;
}

function classifyReason(err: unknown): "not-found" | "unavailable" | "denied" {
  if (err instanceof TokenExchangeError) {
    switch (err.code) {
      case "invalid_grant":
      case "invalid_client":
      case "unauthorized_client":
      case "access_denied":
      case "invalid_scope":
        return "denied";
      case "invalid_target":
        return "not-found";
      default:
        return "unavailable";
    }
  }
  return "unavailable";
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

type CreateKeycardSecretSourceFactoryPublic = typeof createKeycardSecretSourceFactory;
export type { CreateKeycardSecretSourceFactoryPublic };

export { KeycardSecretSource as _KeycardSecretSource };
