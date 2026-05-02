/**
 * Identity-assertion acquisition strategies for the Keycard plugin.
 *
 * Each strategy returns a `ClientAssertion` — a proof-of-identity the
 * Keycard zone accepts at its token endpoint. The specific shape depends on
 * the method:
 *
 *   - `workload-identity`: a signed JWT minted by an external issuer
 *     (macOS daemon, token file, SPIFFE, or a static test string). Used as
 *     the RFC 7523 `client_assertion` with type
 *     `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`.
 *   - `client-credentials`: a client id + secret used by the exchange
 *     client as HTTP Basic auth (no JWT assertion).
 *   - `private-key-jwt`: a JWT signed by the gateway's private key, also
 *     presented as `client_assertion`.
 *
 * The strategies below are plugin-internal. They are not an SDK extension
 * point — if a second plugin ever needs macOS-daemon acquisition the shared
 * code becomes an npm helper first.
 */

import { createHash, createPrivateKey, createSign, KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import type { KeycardIdentityMethod } from "./schema.js";

export type ClientAssertion =
  | {
      /** A signed JWT presented as RFC 7523 `client_assertion`. */
      kind: "jwt-bearer";
      token: string;
      /** Absolute expiry (`Date.now()` ms) for the embedded token, if known. */
      expiresAt?: number;
    }
  | {
      /** HTTP Basic auth on the token endpoint. No `client_assertion` used. */
      kind: "client-basic";
      clientId: string;
      clientSecret: string;
    };

export type IdentityAcquisitionEnv = {
  /** Resolve a SecretRef to its plaintext value. Injected by the caller. */
  resolveSecretRef?: (ref: { source: string; provider: string; id: string }) => Promise<string>;
  /** Override now() for deterministic tests. */
  now?: () => number;
  /** Override the macOS UDS round-trip implementation (tests). */
  macosDaemonClient?: MacosDaemonClient;
  /** Override the token-file reader (tests). */
  readTokenFile?: (path: string) => Promise<string>;
};

export type MacosDaemonTokenRequest = {
  socketPath: string;
  audience: string;
  timeoutMs: number;
};

export type MacosDaemonTokenResponse = {
  token: string;
  expiresAt?: number;
};

export type MacosDaemonClient = (
  request: MacosDaemonTokenRequest,
) => Promise<MacosDaemonTokenResponse>;

const DEFAULT_MACOS_DAEMON_SOCKET = "/var/run/keycard-osx-oidcd.sock";
const DEFAULT_MACOS_DAEMON_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export type AcquireAssertionOptions = {
  /** Value to request for the `audience` claim when the strategy signs a JWT. */
  tokenEndpoint: string;
  /** Zone issuer URL — used as the JWT `iss` when the plugin signs. */
  issuer: string;
  /** Zone id — used as the JWT `sub` for client-credentials / private-key JWT. */
  clientIdForAssertion: string;
};

/**
 * Acquire a `ClientAssertion` for the given identity method. Implementations
 * are pure with respect to `env`: injecting `macosDaemonClient`,
 * `readTokenFile`, and `resolveSecretRef` is how tests exercise them
 * deterministically.
 */
export async function acquireClientAssertion(
  method: KeycardIdentityMethod,
  options: AcquireAssertionOptions,
  env: IdentityAcquisitionEnv = {},
): Promise<ClientAssertion> {
  if (method.kind === "workload-identity") {
    return await acquireWorkloadIdentity(method.source, options, env);
  }
  if (method.kind === "client-credentials") {
    const clientSecret = await resolveRequiredSecret(method.clientSecret, env);
    return {
      kind: "client-basic",
      clientId: method.clientId,
      clientSecret,
    };
  }
  if (method.kind === "private-key-jwt") {
    const pem = await resolveRequiredSecret(method.privateKey, env);
    const token = await signPrivateKeyJwt({
      pem,
      keyId: method.keyId,
      clientId: method.clientId,
      audience: options.tokenEndpoint,
      signingAlg: method.signingAlg ?? "RS256",
      now: env.now,
    });
    return { kind: "jwt-bearer", token: token.token, expiresAt: token.expiresAt };
  }
  const exhaustive: never = method;
  throw new Error(`Unsupported identity method: ${JSON.stringify(exhaustive)}`);
}

// ---------------------------------------------------------------------------
// Workload-identity sources
// ---------------------------------------------------------------------------

async function acquireWorkloadIdentity(
  source: Extract<KeycardIdentityMethod, { kind: "workload-identity" }>["source"],
  options: AcquireAssertionOptions,
  env: IdentityAcquisitionEnv,
): Promise<ClientAssertion> {
  if (source.type === "macos-daemon") {
    const client = env.macosDaemonClient ?? macosDaemonUdsClient;
    const response = await client({
      socketPath: source.socketPath ?? DEFAULT_MACOS_DAEMON_SOCKET,
      audience: options.tokenEndpoint,
      timeoutMs: source.timeoutMs ?? DEFAULT_MACOS_DAEMON_TIMEOUT_MS,
    });
    return {
      kind: "jwt-bearer",
      token: response.token,
      ...(typeof response.expiresAt === "number" ? { expiresAt: response.expiresAt } : {}),
    };
  }
  if (source.type === "token-file") {
    const reader = env.readTokenFile ?? readTokenFileFromDisk;
    const contents = await reader(source.path);
    const token = contents.trim();
    if (!token) {
      throw new Error(`token-file is empty: ${source.path}`);
    }
    return { kind: "jwt-bearer", token };
  }
  if (source.type === "static-test") {
    return {
      kind: "jwt-bearer",
      token: source.token,
      ...(typeof source.expiresAt === "number" ? { expiresAt: source.expiresAt } : {}),
    };
  }
  if (source.type === "spiffe") {
    throw new Error(
      "SPIFFE workload identity source is declared but not yet implemented by this plugin.",
    );
  }
  const exhaustive: never = source;
  throw new Error(`Unsupported workload identity source: ${JSON.stringify(exhaustive)}`);
}

async function readTokenFileFromDisk(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString("utf8");
}

// ---------------------------------------------------------------------------
// macOS daemon UDS protocol — JSON line-oriented
// ---------------------------------------------------------------------------

type MacosDaemonRawResponse = {
  token: string;
  expires_at?: number;
  error?: string;
  [k: string]: unknown;
};

export const macosDaemonUdsClient: MacosDaemonClient = async (request) => {
  const payload = `${JSON.stringify({ op: "token", audience: request.audience })}\n`;
  const raw = await udsRoundTrip(request.socketPath, payload, request.timeoutMs);
  let parsed: MacosDaemonRawResponse;
  try {
    parsed = JSON.parse(raw) as MacosDaemonRawResponse;
  } catch (err) {
    throw new Error(
      `keycard-osx-oidcd returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed.error === "string") {
    throw new Error(`keycard-osx-oidcd error: ${parsed.error}`);
  }
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error("keycard-osx-oidcd response missing token");
  }
  const result: MacosDaemonTokenResponse = { token: parsed.token };
  if (typeof parsed.expires_at === "number") {
    result.expiresAt = parsed.expires_at * 1_000;
  }
  return result;
};

function udsRoundTrip(socketPath: string, payload: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) {
        reject(err);
        return;
      }
      const buf = Buffer.concat(chunks).toString("utf8").trim();
      if (!buf) {
        reject(new Error(`keycard-osx-oidcd closed without response (socket ${socketPath})`));
        return;
      }
      const firstLine = buf.split("\n", 1)[0];
      resolve(firstLine ?? buf);
    };

    const timer = setTimeout(
      () => finish(new Error(`keycard-osx-oidcd timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();

    socket.on("connect", () => {
      socket.end(payload);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      finish(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

// ---------------------------------------------------------------------------
// private-key JWT (RFC 7523)
// ---------------------------------------------------------------------------

type SignedJwt = {
  token: string;
  expiresAt: number;
};

const DEFAULT_PRIVATE_KEY_JWT_LIFETIME_SEC = 300;

export async function signPrivateKeyJwt(params: {
  pem: string;
  keyId: string;
  clientId: string;
  audience: string;
  signingAlg: "RS256" | "ES256";
  lifetimeSec?: number;
  now?: () => number;
}): Promise<SignedJwt> {
  const key = createPrivateKey(params.pem);
  const nowMs = (params.now ?? Date.now)();
  const iat = Math.floor(nowMs / 1_000);
  const lifetime = params.lifetimeSec ?? DEFAULT_PRIVATE_KEY_JWT_LIFETIME_SEC;
  const exp = iat + lifetime;

  const header = { alg: params.signingAlg, typ: "JWT", kid: params.keyId };
  const claims = {
    iss: params.clientId,
    sub: params.clientId,
    aud: params.audience,
    jti: randomJti(params.keyId, nowMs),
    iat,
    nbf: iat,
    exp,
  };

  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = signJwtSignature(key, params.signingAlg, signingInput);
  return {
    token: `${signingInput}.${signature}`,
    expiresAt: exp * 1_000,
  };
}

function signJwtSignature(key: KeyObject, alg: "RS256" | "ES256", signingInput: string): string {
  const signer = createSign(alg === "RS256" ? "RSA-SHA256" : "sha256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key);
  return toBase64Url(sig);
}

function base64UrlJson(obj: unknown): string {
  return toBase64Url(Buffer.from(JSON.stringify(obj), "utf8"));
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/u, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function randomJti(keyId: string, nowMs: number): string {
  // Deterministic-enough-for-not-replayable: hash of kid + time + random bytes.
  return createHash("sha256")
    .update(`${keyId}:${nowMs}:${Math.random()}`)
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// SecretRef resolution indirection
// ---------------------------------------------------------------------------

async function resolveRequiredSecret(
  ref: { source: string; provider: string; id: string },
  env: IdentityAcquisitionEnv,
): Promise<string> {
  if (!env.resolveSecretRef) {
    throw new Error(
      `SecretRef resolution not available for ${ref.source}:${ref.provider}:${ref.id}. The plugin needs a resolveSecretRef implementation injected by the host.`,
    );
  }
  const value = await env.resolveSecretRef(ref);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `SecretRef ${ref.source}:${ref.provider}:${ref.id} resolved to an empty value.`,
    );
  }
  return value;
}
