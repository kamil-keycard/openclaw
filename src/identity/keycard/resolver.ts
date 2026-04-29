/**
 * High-level resolver that turns a Keycard provider mapping into an opaque
 * access token usable as an API key by the rest of OpenClaw.
 *
 * Responsibilities:
 *  - Discover the configured Keycard zone's authorization-server metadata.
 *  - Mint local-OIDC JWTs (cached per audience by `LocalIdentityTokenCache`).
 *  - Exchange those JWTs for resource-scoped access tokens (single-flight per
 *    resource, TTL-cached with a 60s skew).
 *  - Gate the entire flow on macOS availability so callers can keep falling
 *    back to legacy auth when the daemon is unreachable.
 */
import { createSubsystemLogger, type SubsystemLogger } from "../../logging/subsystem.js";
import {
  discoverAuthorizationServerMetadata,
  exchangeForResource,
  type AuthorizationServerMetadata,
  type DiscoveryOptions,
  type ExchangeOptions,
} from "./exchange.js";
import {
  isLocalIdentityAvailable,
  LocalIdentityTokenCache,
  LocalIdentityUnavailableError,
  type LocalIdentityClientOptions,
} from "./local-oidc.js";
import {
  effectiveProviderMappings,
  resolveKeycardResourceForProvider,
  type KeycardIdentityConfig,
  type KeycardProviderEntry,
} from "./types.js";

const log: SubsystemLogger = createSubsystemLogger("identity/keycard/resolver");

const REFRESH_SKEW_SECONDS = 60;
const MIN_TOKEN_TTL_SECONDS = 30;
const FALLBACK_TOKEN_TTL_SECONDS = 5 * 60;
/**
 * Soft bound on the per-resource token cache. Per-agent resolution multiplies
 * cache fanout by the active agent count, so we cap entries to keep a
 * runaway agent population from growing the cache unbounded. Eviction is
 * insertion-order LRU on cache miss.
 */
const DEFAULT_EXCHANGE_CACHE_MAX_ENTRIES = 256;
const GATEWAY_AGENT_CACHE_SLOT = "_gateway";

export type KeycardResolverOptions = {
  identity: KeycardIdentityConfig;
  /** Inject a fetch implementation (defaults to `globalThis.fetch`). */
  fetchImpl?: typeof fetch;
  /** Inject a clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Override discovery options (timeout, issuer override). */
  discoveryOptions?: DiscoveryOptions;
  /** Override exchange options (timeout). */
  exchangeOptions?: ExchangeOptions;
  /** Override local-identity CLI options (binary path, timeout, socket path). */
  localIdentityOptions?: LocalIdentityClientOptions;
  /**
   * Soft cap for per-(resource, agent) cached tokens. Defaults to 256 — large
   * enough for typical deployments while still bounding memory if agents are
   * created/destroyed rapidly. Insertion-order LRU on miss.
   */
  exchangeCacheMaxEntries?: number;
};

/** Per-call options for resource/provider resolution. */
export type ResolveOptions = {
  /**
   * Optional agent id. When set the resolver mints a JWT carrying an
   * `agent_id` claim (forwarded to the daemon as `--agent`) and caches the
   * exchanged access token under a key scoped to this agent.
   */
  agentId?: string;
};

export type KeycardResolveOutcome =
  | { ok: true; accessToken: string; expiresAt?: number; resource: string }
  | { ok: false; reason: KeycardUnavailableReason; message: string };

export type KeycardUnavailableReason =
  | "not-darwin"
  | "socket-missing"
  | "no-mapping"
  | "discovery-failed"
  | "exchange-failed"
  | "local-identity-failed";

export type KeycardResolver = {
  /** Returns the configured identity for diagnostics/onboarding. */
  config(): KeycardIdentityConfig;
  /** Returns the per-provider mapping, including built-in defaults. */
  providerMappings(): Record<string, KeycardProviderEntry>;
  /**
   * Resolve a Keycard resource indicator to an opaque access token, returning
   * a tagged outcome rather than throwing so callers can fall through to
   * legacy auth. Pass `options.agentId` to bind the exchange to a per-agent
   * `agent_id` JWT claim.
   */
  resolveResource(resource: string, options?: ResolveOptions): Promise<KeycardResolveOutcome>;
  /** Resolve the resource for `providerId` (after layering defaults). */
  resolveProvider(providerId: string, options?: ResolveOptions): Promise<KeycardResolveOutcome>;
  /**
   * Warm caches for all configured resources. Returns the per-resource
   * outcomes so the caller can log/diagnose individually. Operates on the
   * gateway-scoped identity (no `agentId`).
   */
  prefetch(): Promise<{ resource: string; outcome: KeycardResolveOutcome }[]>;
  /** Drop cached tokens (and rediscovery state). */
  dispose(): void;
};

type CachedAccessToken = {
  promise: Promise<{ accessToken: string; expiresAtMs: number }>;
  /** Expiry as wall-clock ms; 0 while the request is pending. */
  expiresAtMs: number;
};

function exchangeCacheKey(resource: string, agentId: string | undefined): string {
  return `${resource}|${agentId ?? GATEWAY_AGENT_CACHE_SLOT}`;
}

export function createKeycardResolver(options: KeycardResolverOptions): KeycardResolver {
  const identity = options.identity;
  const now = options.now ?? Date.now;
  const localIdentityCache = new LocalIdentityTokenCache(options.localIdentityOptions ?? {}, now);
  const exchangeCache = new Map<string, CachedAccessToken>();
  const exchangeCacheMaxEntries =
    options.exchangeCacheMaxEntries && options.exchangeCacheMaxEntries > 0
      ? options.exchangeCacheMaxEntries
      : DEFAULT_EXCHANGE_CACHE_MAX_ENTRIES;
  let discoveryPromise: Promise<AuthorizationServerMetadata> | undefined;

  const ensureMetadata = (): Promise<AuthorizationServerMetadata> => {
    if (discoveryPromise) {
      return discoveryPromise;
    }
    discoveryPromise = discoverAuthorizationServerMetadata(identity.zoneId, {
      ...options.discoveryOptions,
      fetchImpl: options.fetchImpl ?? options.discoveryOptions?.fetchImpl,
    }).catch((err: unknown) => {
      discoveryPromise = undefined;
      throw err;
    });
    return discoveryPromise;
  };

  const mintAccessToken = async (
    resource: string,
    agentId: string | undefined,
  ): Promise<{
    accessToken: string;
    expiresAtMs: number;
  }> => {
    const metadata = await ensureMetadata();
    const audience = identity.audience?.trim() || metadata.token_endpoint;
    const localToken = await localIdentityCache.getToken(audience, agentId);
    const exchange = await exchangeForResource(
      {
        tokenEndpoint: metadata.token_endpoint,
        clientAssertion: localToken.token,
        resource,
      },
      {
        ...options.exchangeOptions,
        fetchImpl: options.fetchImpl ?? options.exchangeOptions?.fetchImpl,
      },
    );
    const ttlSeconds = Math.max(
      MIN_TOKEN_TTL_SECONDS,
      exchange.expiresIn ?? FALLBACK_TOKEN_TTL_SECONDS,
    );
    return {
      accessToken: exchange.accessToken,
      expiresAtMs: now() + ttlSeconds * 1_000,
    };
  };

  const evictOldestIfNeeded = (): void => {
    while (exchangeCache.size >= exchangeCacheMaxEntries) {
      const oldest = exchangeCache.keys().next();
      if (oldest.done) {
        return;
      }
      exchangeCache.delete(oldest.value);
    }
  };

  const getOrMint = (resource: string, agentId: string | undefined) => {
    const key = exchangeCacheKey(resource, agentId);
    const existing = exchangeCache.get(key);
    const cutoff = now() + REFRESH_SKEW_SECONDS * 1_000;
    if (existing && existing.expiresAtMs > cutoff) {
      // Refresh insertion order so frequently-used entries survive eviction.
      exchangeCache.delete(key);
      exchangeCache.set(key, existing);
      return existing.promise;
    }
    evictOldestIfNeeded();
    const pending = mintAccessToken(resource, agentId).then(
      (token) => {
        exchangeCache.set(key, {
          promise: Promise.resolve(token),
          expiresAtMs: token.expiresAtMs,
        });
        return token;
      },
      (err: unknown) => {
        exchangeCache.delete(key);
        throw err;
      },
    );
    exchangeCache.set(key, { promise: pending, expiresAtMs: 0 });
    return pending;
  };

  const resolveResource = async (
    resource: string,
    resolveOptions?: ResolveOptions,
  ): Promise<KeycardResolveOutcome> => {
    const trimmed = resource.trim();
    if (!trimmed) {
      return { ok: false, reason: "no-mapping", message: "Empty Keycard resource indicator." };
    }
    const agentId = resolveOptions?.agentId?.trim() || undefined;
    const availability = await isLocalIdentityAvailable(options.localIdentityOptions);
    if (!availability.available) {
      const reason = availability.reason === "not-darwin" ? "not-darwin" : "socket-missing";
      const message =
        reason === "not-darwin"
          ? "Keycard local OIDC issuer is only supported on macOS; falling back to legacy auth."
          : `Keycard local OIDC daemon socket not found at ${availability.socketPath}.`;
      return { ok: false, reason, message };
    }
    try {
      const token = await getOrMint(trimmed, agentId);
      return {
        ok: true,
        accessToken: token.accessToken,
        expiresAt: Math.floor(token.expiresAtMs / 1_000),
        resource: trimmed,
      };
    } catch (err) {
      if (err instanceof LocalIdentityUnavailableError) {
        return {
          ok: false,
          reason: err.reason === "not-darwin" ? "not-darwin" : "socket-missing",
          message: err.message,
        };
      }
      const name = err instanceof Error ? err.name : "Error";
      const message = err instanceof Error ? err.message : String(err);
      const reason: KeycardUnavailableReason =
        name === "KeycardDiscoveryError"
          ? "discovery-failed"
          : name === "KeycardTokenExchangeError"
            ? "exchange-failed"
            : name === "LocalIdentityRequestError"
              ? "local-identity-failed"
              : "exchange-failed";
      log.warn?.(`Keycard resolution for ${trimmed} failed: ${message}`, {
        resource: trimmed,
        reason,
        agentId,
      });
      return { ok: false, reason, message };
    }
  };

  const providerMappings = (): Record<string, KeycardProviderEntry> =>
    effectiveProviderMappings(identity);

  return {
    config: () => identity,
    providerMappings,
    resolveResource,
    async resolveProvider(providerId: string, resolveOptions?: ResolveOptions) {
      const resource = resolveKeycardResourceForProvider(identity, providerId);
      if (!resource) {
        return {
          ok: false,
          reason: "no-mapping",
          message: `No Keycard resource mapping for provider "${providerId}".`,
        };
      }
      return resolveResource(resource, resolveOptions);
    },
    async prefetch() {
      const mappings = providerMappings();
      const seen = new Set<string>();
      const targets: string[] = [];
      for (const entry of Object.values(mappings)) {
        if (!seen.has(entry.resource)) {
          seen.add(entry.resource);
          targets.push(entry.resource);
        }
      }
      const outcomes: { resource: string; outcome: KeycardResolveOutcome }[] = [];
      for (const resource of targets) {
        const outcome = await resolveResource(resource);
        outcomes.push({ resource, outcome });
      }
      return outcomes;
    },
    dispose() {
      exchangeCache.clear();
      localIdentityCache.invalidate();
      discoveryPromise = undefined;
    },
  };
}
