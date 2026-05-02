/**
 * Keycard credential exchange client.
 *
 * Implements the minimum RFC 8414 (OAuth authorization server metadata),
 * RFC 6749 §4.4 (client credentials grant), RFC 7523 (JWT-bearer client
 * assertion), and RFC 8707 (resource indicator) surface area the plugin needs.
 *
 * The gateway acts on its own behalf — it authenticates to the Keycard zone
 * with a client assertion and requests resource-scoped access tokens. There
 * is no subject token; the "acting party" and "authenticated party" are the
 * same entity.
 *
 * Kept self-contained instead of depending on `@keycardai/oauth` so the
 * plugin has zero runtime deps outside its own package and so tests can
 * stub `fetch` directly without matrixing through an external client.
 */

import type { ClientAssertion } from "./identity.js";

export const JWT_BEARER_CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const CLIENT_CREDENTIALS_GRANT_TYPE = "client_credentials";

export type TokenExchangeFetch = (url: string, init: RequestInit) => Promise<Response>;

export type AuthorizationServerMetadata = {
  issuer: string;
  token_endpoint: string;
};

export async function discoverAuthorizationServer(
  issuer: string,
  fetchImpl: TokenExchangeFetch = fetch,
  options: { signal?: AbortSignal } = {},
): Promise<AuthorizationServerMetadata> {
  const issuerURL = new URL(issuer);
  const trimmedPath = issuerURL.pathname.replace(/\/$/u, "");
  const discoveryUrl = new URL(
    `/.well-known/oauth-authorization-server${trimmedPath}`,
    `${issuerURL.protocol}//${issuerURL.host}`,
  );

  const response = await fetchImpl(discoveryUrl.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `RFC 8414 discovery failed for ${issuer}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as Record<string, unknown>;
  if (typeof json.issuer !== "string") {
    throw new Error(`RFC 8414 discovery for ${issuer} missing "issuer"`);
  }
  if (typeof json.token_endpoint !== "string" || json.token_endpoint.length === 0) {
    throw new Error(`RFC 8414 discovery for ${issuer} missing "token_endpoint"`);
  }
  if (json.issuer !== issuer) {
    throw new Error(
      `RFC 8414 discovery issuer mismatch for ${issuer}: server returned "${String(json.issuer)}"`,
    );
  }
  return { issuer, token_endpoint: json.token_endpoint };
}

export type TokenExchangeResponse = {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  /** Absolute expiry (`Date.now()` ms), computed if the response included `expires_in`. */
  expiresAt?: number;
  scope?: string;
};

export type TokenExchangeRequest = {
  tokenEndpoint: string;
  /** Client assertion (RFC 7523) or HTTP Basic client credentials. */
  assertion: ClientAssertion;
  /** RFC 8707 resource indicator — the upstream API the token grants access to. */
  resource?: string;
  scopes?: string[];
  now?: () => number;
};

export async function performTokenExchange(
  request: TokenExchangeRequest,
  fetchImpl: TokenExchangeFetch = fetch,
  options: { signal?: AbortSignal } = {},
): Promise<TokenExchangeResponse> {
  const params = new URLSearchParams();
  params.set("grant_type", CLIENT_CREDENTIALS_GRANT_TYPE);

  if (request.resource) {
    params.set("resource", request.resource);
  }
  if (request.scopes && request.scopes.length > 0) {
    params.set("scope", request.scopes.join(" "));
  }

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (request.assertion.kind === "jwt-bearer") {
    params.set("client_assertion_type", JWT_BEARER_CLIENT_ASSERTION_TYPE);
    params.set("client_assertion", request.assertion.token);
  } else if (request.assertion.kind === "client-basic") {
    const encoded = Buffer.from(
      `${encodeFormComponent(request.assertion.clientId)}:${encodeFormComponent(request.assertion.clientSecret)}`,
    ).toString("base64");
    headers.authorization = `Basic ${encoded}`;
  }

  const response = await fetchImpl(request.tokenEndpoint, {
    method: "POST",
    headers,
    body: params.toString(),
    signal: options.signal,
  });

  const now = (request.now ?? Date.now)();

  if (!response.ok) {
    let errorCode = "token_exchange_failed";
    let description = `HTTP ${response.status}`;
    try {
      const errJson = (await response.json()) as Record<string, unknown>;
      if (typeof errJson.error === "string") {
        errorCode = errJson.error;
      }
      if (typeof errJson.error_description === "string") {
        description = errJson.error_description;
      }
    } catch {
      description = `HTTP ${response.status} ${response.statusText}`;
    }
    throw new TokenExchangeError(errorCode, description, response.status);
  }

  const json = (await response.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new TokenExchangeError(
      "invalid_response",
      "token exchange response missing access_token",
      response.status,
    );
  }
  const tokenType = typeof json.token_type === "string" ? json.token_type : "bearer";
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  const scope = typeof json.scope === "string" ? json.scope : undefined;

  const result: TokenExchangeResponse = {
    accessToken: json.access_token,
    tokenType,
  };
  if (typeof expiresIn === "number") {
    result.expiresIn = expiresIn;
    result.expiresAt = now + expiresIn * 1_000;
  }
  if (scope) {
    result.scope = scope;
  }
  return result;
}

function encodeFormComponent(value: string): string {
  // Per OAuth 2.0 spec: form-url-encode both the client id and secret before basic-encoding.
  return encodeURIComponent(value).replace(/%20/g, "+");
}

export class TokenExchangeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, description: string, status: number) {
    super(`token exchange ${code}: ${description}`);
    this.name = "TokenExchangeError";
    this.code = code;
    this.status = status;
  }
}
