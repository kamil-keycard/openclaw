/**
 * RFC 6749 / 7523 / 8707 token exchange client for Keycard zones.
 *
 * Flow:
 *   1. Discover the zone's authorization-server metadata (RFC 8414) once,
 *      cache the `token_endpoint`.
 *   2. POST `client_credentials` with a JWT-bearer client assertion
 *      (RFC 7523) and a `resource` indicator (RFC 8707).
 *   3. Hand the response back to the caller as an opaque blob — Keycard
 *      decides whether the returned `access_token` is the upstream API key,
 *      a Keycard-fronted Bearer, or something else entirely. We do not
 *      interpret it.
 */
import { createSubsystemLogger, type SubsystemLogger } from "../../logging/subsystem.js";

const log: SubsystemLogger = createSubsystemLogger("identity/keycard/exchange");

export const KEYCARD_DEFAULT_DOMAIN = "keycard.cloud";
export const JWT_BEARER_CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;

export type AuthorizationServerMetadata = {
  issuer: string;
  token_endpoint: string;
  jwks_uri?: string;
  /** Other discovery fields are kept for diagnostics but not interpreted. */
  raw: Record<string, unknown>;
};

export type DiscoveryOptions = {
  /** Allow callers (and tests) to substitute the fetch implementation. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Override the issuer URL (defaults to `https://<zoneId>.keycard.cloud`). */
  issuer?: string;
};

export type ExchangeRequest = {
  tokenEndpoint: string;
  clientAssertion: string;
  resource: string;
  /** Optional scope hint forwarded to the AS; usually unused for Keycard. */
  scope?: string;
  /** Optional extra form fields for callers that need to extend the grant. */
  extraFormFields?: Record<string, string>;
};

export type ExchangeOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type ExchangeResponse = {
  /** Opaque token Keycard returned. We do not interpret it. */
  accessToken: string;
  tokenType?: string;
  /** Seconds until the token expires, if Keycard sent it. */
  expiresIn?: number;
  /** Original parsed JSON body, for callers that want raw access. */
  raw: Record<string, unknown>;
};

export class KeycardDiscoveryError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "KeycardDiscoveryError";
    this.status = status;
  }
}

export class KeycardTokenExchangeError extends Error {
  readonly status?: number;
  /** OAuth `error` field if returned by the AS. */
  readonly oauthError?: string;
  /** OAuth `error_description` field if returned. */
  readonly oauthErrorDescription?: string;
  constructor(params: {
    message: string;
    status?: number;
    oauthError?: string;
    oauthErrorDescription?: string;
  }) {
    super(params.message);
    this.name = "KeycardTokenExchangeError";
    this.status = params.status;
    this.oauthError = params.oauthError;
    this.oauthErrorDescription = params.oauthErrorDescription;
  }
}

/**
 * Build the canonical issuer URL for a Keycard zone id (e.g. `o36mbsre94...`).
 * Shared so callers can derive the audience for the JWT-bearer assertion
 * without re-doing string concatenation.
 */
export function issuerForZone(zoneId: string, domain: string = KEYCARD_DEFAULT_DOMAIN): string {
  const trimmed = zoneId.trim();
  if (!trimmed) {
    throw new KeycardDiscoveryError("Keycard zoneId is required.");
  }
  return `https://${trimmed}.${domain}`;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = init.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    clearTimeout(timer);
    throw new Error("globalThis.fetch is not available in this runtime.");
  }
  try {
    const { fetchImpl: _ignoredImpl, timeoutMs: _ignoredTimeout, ...rest } = init;
    void _ignoredImpl;
    void _ignoredTimeout;
    const response = await fetchImpl(url, { ...rest, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const discoveryCache = new Map<string, Promise<AuthorizationServerMetadata>>();

/**
 * RFC 8414 discovery against `<issuer>/.well-known/oauth-authorization-server`.
 * Results are cached per issuer for the life of the process.
 */
export async function discoverAuthorizationServerMetadata(
  zoneIdOrIssuer: string,
  options: DiscoveryOptions = {},
): Promise<AuthorizationServerMetadata> {
  const issuer = options.issuer ?? deriveIssuer(zoneIdOrIssuer);
  const cached = discoveryCache.get(issuer);
  if (cached) {
    return cached;
  }
  const promise = (async (): Promise<AuthorizationServerMetadata> => {
    const url = `${issuer.replace(/\/$/u, "")}/.well-known/oauth-authorization-server`;
    log.debug?.("Fetching Keycard authorization-server metadata", { url });
    const { status, body } = await fetchJsonWithTimeout(url, {
      method: "GET",
      headers: { accept: "application/json" },
      timeoutMs: options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
    });
    if (status !== 200) {
      throw new KeycardDiscoveryError(
        `Authorization-server discovery failed (HTTP ${status}) for ${issuer}.`,
        status,
      );
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new KeycardDiscoveryError(
        `Authorization-server discovery returned non-object payload for ${issuer}.`,
      );
    }
    const record = body as Record<string, unknown>;
    const issuerClaim = typeof record.issuer === "string" ? record.issuer : undefined;
    const tokenEndpoint =
      typeof record.token_endpoint === "string" ? record.token_endpoint : undefined;
    if (!issuerClaim) {
      throw new KeycardDiscoveryError(`Discovery payload missing 'issuer' for ${issuer}.`);
    }
    if (!tokenEndpoint) {
      throw new KeycardDiscoveryError(`Discovery payload missing 'token_endpoint' for ${issuer}.`);
    }
    return {
      issuer: issuerClaim,
      token_endpoint: tokenEndpoint,
      jwks_uri: typeof record.jwks_uri === "string" ? record.jwks_uri : undefined,
      raw: record,
    };
  })();
  discoveryCache.set(issuer, promise);
  promise.catch(() => discoveryCache.delete(issuer));
  return promise;
}

function deriveIssuer(zoneIdOrIssuer: string): string {
  const trimmed = zoneIdOrIssuer.trim();
  if (!trimmed) {
    throw new KeycardDiscoveryError("zoneId or issuer is required for discovery.");
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/$/u, "");
  }
  return issuerForZone(trimmed);
}

/**
 * Test-only: clear cached metadata so unit tests can re-mock fetch responses.
 */
export function resetDiscoveryCacheForTests(): void {
  discoveryCache.clear();
}

function extractOauthError(body: unknown): { error?: string; description?: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  const record = body as Record<string, unknown>;
  const error = typeof record.error === "string" ? record.error : undefined;
  const description =
    typeof record.error_description === "string" ? record.error_description : undefined;
  return { error, description };
}

/**
 * Perform the RFC 6749 §4.4 client-credentials grant authenticated with an
 * RFC 7523 JWT-bearer client assertion and an RFC 8707 resource indicator.
 */
export async function exchangeForResource(
  request: ExchangeRequest,
  options: ExchangeOptions = {},
): Promise<ExchangeResponse> {
  if (!request.tokenEndpoint.trim()) {
    throw new KeycardTokenExchangeError({ message: "tokenEndpoint is required." });
  }
  if (!request.clientAssertion.trim()) {
    throw new KeycardTokenExchangeError({ message: "clientAssertion is required." });
  }
  const resource = request.resource.trim();
  if (!resource) {
    throw new KeycardTokenExchangeError({ message: "resource is required." });
  }
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_assertion_type", JWT_BEARER_CLIENT_ASSERTION_TYPE);
  params.set("client_assertion", request.clientAssertion);
  params.set("resource", resource);
  if (request.scope) {
    params.set("scope", request.scope);
  }
  for (const [key, value] of Object.entries(request.extraFormFields ?? {})) {
    params.set(key, value);
  }
  log.debug?.("Exchanging local identity for Keycard resource token", {
    tokenEndpoint: request.tokenEndpoint,
    resource,
  });
  const { status, body } = await fetchJsonWithTimeout(request.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
    timeoutMs: options.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  });
  if (status < 200 || status >= 300) {
    const { error, description } = extractOauthError(body);
    throw new KeycardTokenExchangeError({
      message: `Keycard token exchange failed (HTTP ${status})${error ? `: ${error}${description ? ` — ${description}` : ""}` : ""} for resource ${resource}.`,
      status,
      oauthError: error,
      oauthErrorDescription: description,
    });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new KeycardTokenExchangeError({
      message: `Keycard token exchange returned non-object payload for resource ${resource}.`,
      status,
    });
  }
  const record = body as Record<string, unknown>;
  const accessToken = typeof record.access_token === "string" ? record.access_token : undefined;
  if (!accessToken) {
    throw new KeycardTokenExchangeError({
      message: `Keycard token exchange response missing access_token for resource ${resource}.`,
      status,
    });
  }
  const expiresIn =
    typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
      ? record.expires_in
      : undefined;
  return {
    accessToken,
    tokenType: typeof record.token_type === "string" ? record.token_type : undefined,
    expiresIn,
    raw: record,
  };
}
