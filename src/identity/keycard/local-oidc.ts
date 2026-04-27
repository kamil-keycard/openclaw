/**
 * Local OIDC client for the macOS-only `keycard-osx-oidc` daemon.
 *
 * The daemon issues short-lived JWTs that represent the current OS user. This
 * module wraps the daemon's user-facing CLI (`keycard-osx-oidc token --audience
 * <aud>`) — that CLI is the stable contract documented in the daemon's README
 * (`examples/python-whoami` shows the alternative direct-UDS path). Shelling
 * out keeps us decoupled from the daemon's internal wire protocol and uses
 * only Node stdlib (`node:child_process`) — no new dependencies.
 *
 * The kernel binds the JWT's claims to the connecting process's UID via
 * `getpeereid()` on the daemon side, so the token we get back represents the
 * current OS user regardless of arguments.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { createSubsystemLogger, type SubsystemLogger } from "../../logging/subsystem.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SOCKET_PATH = "/var/run/keycard-osx-oidcd.sock";
const DEFAULT_CLI_BINARY = "keycard-osx-oidc";
const DEFAULT_TOKEN_TIMEOUT_MS = 5_000;
const REFRESH_SKEW_MS = 5 * 60 * 1_000;

const log: SubsystemLogger = createSubsystemLogger("identity/keycard/local-oidc");

export type LocalIdentityToken = {
  /** Raw signed JWT (compact serialization). */
  token: string;
  /** Wall-clock UNIX seconds of `exp` decoded from the JWT payload. */
  expiresAt: number;
  /** Decoded JWT payload, exposed for diagnostics; do not trust without verification. */
  claims: Record<string, unknown>;
};

export type LocalIdentityClientOptions = {
  /** Path to the daemon socket; surfaced for diagnostics, not used by the CLI. */
  socketPath?: string;
  /** Override the CLI binary path. Defaults to PATH lookup of `keycard-osx-oidc`. */
  binaryPath?: string;
  /** Maximum time to wait for the CLI to return a token. */
  timeoutMs?: number;
};

export type LocalIdentityRequest = {
  /** Audience to embed in the issued JWT (typically the Keycard token endpoint). */
  audience: string;
} & LocalIdentityClientOptions;

export type LocalIdentityAvailability = {
  available: boolean;
  reason?: "not-darwin" | "socket-missing";
  socketPath: string;
};

/**
 * Returns whether the local OIDC daemon is reachable from this process. macOS
 * only — every other platform short-circuits to `not-darwin`.
 */
export async function isLocalIdentityAvailable(
  options: LocalIdentityClientOptions = {},
): Promise<LocalIdentityAvailability> {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
  if (process.platform !== "darwin") {
    return { available: false, reason: "not-darwin", socketPath };
  }
  try {
    await fs.access(socketPath);
    return { available: true, socketPath };
  } catch {
    return { available: false, reason: "socket-missing", socketPath };
  }
}

export class LocalIdentityUnavailableError extends Error {
  readonly reason: NonNullable<LocalIdentityAvailability["reason"]>;
  constructor(reason: NonNullable<LocalIdentityAvailability["reason"]>, socketPath: string) {
    const detail =
      reason === "not-darwin"
        ? "local OIDC issuer is only supported on macOS"
        : `local OIDC daemon socket not found at ${socketPath}`;
    super(`Keycard local identity unavailable: ${detail}`);
    this.name = "LocalIdentityUnavailableError";
    this.reason = reason;
  }
}

export class LocalIdentityRequestError extends Error {
  readonly stderr?: string;
  constructor(message: string, stderr?: string) {
    super(message);
    this.name = "LocalIdentityRequestError";
    this.stderr = stderr;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new LocalIdentityRequestError(
      `Daemon returned invalid JWT (expected 3 segments, got ${parts.length}).`,
    );
  }
  const payloadB64 = parts[1];
  if (!payloadB64) {
    throw new LocalIdentityRequestError("Daemon returned JWT with empty payload segment.");
  }
  const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(padded, "base64");
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (err) {
    throw new LocalIdentityRequestError(`Failed to parse JWT payload: ${String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalIdentityRequestError("JWT payload is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function extractExpiresAt(claims: Record<string, unknown>): number {
  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new LocalIdentityRequestError("JWT payload missing numeric `exp` claim.");
  }
  return exp;
}

/**
 * Mints a JWT for the requested audience by invoking the daemon's user CLI.
 * The CLI talks to the daemon over UDS (`/var/run/keycard-osx-oidcd.sock`),
 * which the kernel binds to our UID via `getpeereid()`.
 */
export async function requestLocalIdentityToken(
  request: LocalIdentityRequest,
): Promise<LocalIdentityToken> {
  const audience = request.audience.trim();
  if (!audience) {
    throw new LocalIdentityRequestError("Audience is required to mint a local identity token.");
  }
  const availability = await isLocalIdentityAvailable(request);
  if (!availability.available) {
    throw new LocalIdentityUnavailableError(
      availability.reason ?? "socket-missing",
      availability.socketPath,
    );
  }
  const binary = request.binaryPath ?? DEFAULT_CLI_BINARY;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  let stdout: string;
  try {
    const result = await execFileAsync(binary, ["token", "--audience", audience], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr =
      typeof error.stderr === "string"
        ? error.stderr
        : error.stderr instanceof Buffer
          ? error.stderr.toString("utf8")
          : undefined;
    throw new LocalIdentityRequestError(
      `Failed to mint local identity token via ${binary}: ${error.message}`,
      stderr,
    );
  }
  const token = stdout.trim();
  if (!token) {
    throw new LocalIdentityRequestError("Daemon returned empty token output.");
  }
  const claims = decodeJwtPayload(token);
  const expiresAt = extractExpiresAt(claims);
  log.debug?.("Minted local identity token", {
    audience,
    expiresAt,
    sub: typeof claims.sub === "string" ? claims.sub : undefined,
  });
  return { token, expiresAt, claims };
}

type CacheEntry = {
  promise: Promise<LocalIdentityToken>;
  expiresAt: number;
};

/**
 * Per-audience in-process cache. We refresh the token ~5 minutes before `exp`
 * to give downstream Keycard token exchanges plenty of headroom.
 */
export class LocalIdentityTokenCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly options: LocalIdentityClientOptions = {},
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(audience: string): Promise<LocalIdentityToken> {
    const key = audience.trim();
    if (!key) {
      throw new LocalIdentityRequestError("Audience is required to mint a local identity token.");
    }
    const existing = this.entries.get(key);
    const cutoff = this.now() + REFRESH_SKEW_MS;
    if (existing && existing.expiresAt * 1_000 > cutoff) {
      return existing.promise;
    }
    const pending = requestLocalIdentityToken({ ...this.options, audience: key }).then(
      (token) => {
        this.entries.set(key, { promise: Promise.resolve(token), expiresAt: token.expiresAt });
        return token;
      },
      (err: unknown) => {
        this.entries.delete(key);
        throw err;
      },
    );
    this.entries.set(key, { promise: pending, expiresAt: 0 });
    return pending;
  }

  invalidate(audience?: string): void {
    if (audience === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(audience.trim());
  }
}
