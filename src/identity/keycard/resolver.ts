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
   * legacy auth.
   */
  resolveResource(resource: string): Promise<KeycardResolveOutcome>;
  /** Resolve the resource for `providerId` (after layering defaults). */
  resolveProvider(providerId: string): Promise<KeycardResolveOutcome>;
  /**
   * Warm caches for all configured resources. Returns the per-resource
   * outcomes so the caller can log/diagnose individually.
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

export function createKeycardResolver(options: KeycardResolverOptions): KeycardResolver {
  const identity = options.identity;
  const now = options.now ?? Date.now;
  const localIdentityCache = new LocalIdentityTokenCache(options.localIdentityOptions ?? {}, now);
  const exchangeCache = new Map<string, CachedAccessToken>();
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
  ): Promise<{
    accessToken: string;
    expiresAtMs: number;
  }> => {
    const metadata = await ensureMetadata();
    const audience = identity.audience?.trim() || metadata.token_endpoint;
    const localToken = await localIdentityCache.getToken(audience);
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

  const getOrMint = (resource: string) => {
    const existing = exchangeCache.get(resource);
    const cutoff = now() + REFRESH_SKEW_SECONDS * 1_000;
    if (existing && existing.expiresAtMs > cutoff) {
      return existing.promise;
    }
    const pending = mintAccessToken(resource).then(
      (token) => {
        exchangeCache.set(resource, {
          promise: Promise.resolve(token),
          expiresAtMs: token.expiresAtMs,
        });
        return token;
      },
      (err: unknown) => {
        exchangeCache.delete(resource);
        throw err;
      },
    );
    exchangeCache.set(resource, { promise: pending, expiresAtMs: 0 });
    return pending;
  };

  const resolveResource = async (resource: string): Promise<KeycardResolveOutcome> => {
    const trimmed = resource.trim();
    if (!trimmed) {
      return { ok: false, reason: "no-mapping", message: "Empty Keycard resource indicator." };
    }
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
      const token = await getOrMint(trimmed);
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
    async resolveProvider(providerId: string) {
      const resource = resolveKeycardResourceForProvider(identity, providerId);
      if (!resource) {
        return {
          ok: false,
          reason: "no-mapping",
          message: `No Keycard resource mapping for provider "${providerId}".`,
        };
      }
      return resolveResource(resource);
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
