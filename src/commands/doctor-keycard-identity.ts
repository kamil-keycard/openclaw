/**
 * Doctor checks for `gateway.identity.keycard`.
 *
 * Cheap checks always run (config presence, platform, socket file). Probes
 * that touch the network or the local daemon (token-endpoint discovery,
 * per-resource exchange) only run on `doctor --deep` so the default doctor
 * pass stays fast and offline-friendly.
 */
import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  effectiveProviderMappings,
  type KeycardIdentityConfig,
} from "../identity/keycard/types.js";

const DEFAULT_SOCKET_PATH = "/var/run/keycard-osx-oidcd.sock";

export type DoctorNote = (message: string, title?: string) => void;

export type KeycardIdentityDoctorOptions = {
  /** Run network/daemon probes; off by default, paired with `doctor --deep`. */
  deep?: boolean;
  /** Inject a fetch implementation for tests. */
  fetchImpl?: typeof fetch;
  /** Inject a process.platform override for tests. */
  platform?: NodeJS.Platform;
  /** Inject a fs.existsSync override for tests. */
  socketExists?: (socketPath: string) => boolean;
  /** Inject a discovery probe for tests. */
  discoverMetadata?: (zoneId: string) => Promise<{ token_endpoint: string }>;
};

export type KeycardIdentityDoctorResult = {
  /** Whether `gateway.identity.keycard` is configured (after which we report). */
  configured: boolean;
  errors: string[];
  warnings: string[];
  infos: string[];
};

function readIdentity(cfg: OpenClawConfig | undefined): KeycardIdentityConfig | undefined {
  const identity = cfg?.gateway?.identity?.keycard;
  if (!identity || typeof identity.zoneId !== "string" || identity.zoneId.trim().length === 0) {
    return undefined;
  }
  return identity;
}

function defaultDiscover(
  zoneId: string,
  fetchImpl: typeof fetch,
): Promise<{ token_endpoint: string }> {
  // Lightweight inline discovery so the doctor module stays decoupled from the
  // resolver's caching layer.
  const url = `https://${encodeURIComponent(zoneId)}.keycard.cloud/.well-known/oauth-authorization-server`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("discovery timeout")), 5_000);
  return fetchImpl(url, { method: "GET", signal: ctrl.signal })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Keycard discovery returned ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as { token_endpoint?: unknown };
      if (!body || typeof body.token_endpoint !== "string" || body.token_endpoint.length === 0) {
        throw new Error("Keycard discovery missing token_endpoint");
      }
      return { token_endpoint: body.token_endpoint };
    })
    .finally(() => clearTimeout(timer));
}

/**
 * Run Keycard identity diagnostics against `cfg`.
 *
 * Side-effects are limited to building note lines; the caller decides whether
 * to surface them via the existing doctor `note` helper.
 */
export async function runKeycardIdentityDoctor(
  cfg: OpenClawConfig | undefined,
  options: KeycardIdentityDoctorOptions = {},
): Promise<KeycardIdentityDoctorResult> {
  const result: KeycardIdentityDoctorResult = {
    configured: false,
    errors: [],
    warnings: [],
    infos: [],
  };
  const identity = readIdentity(cfg);
  if (!identity) {
    return result;
  }
  result.configured = true;
  const platform = options.platform ?? process.platform;
  const socketPath = identity.socketPath?.trim() || DEFAULT_SOCKET_PATH;
  const exists = options.socketExists ?? ((p: string) => fs.existsSync(p));

  if (platform !== "darwin") {
    result.errors.push(
      [
        `gateway.identity.keycard.zoneId is set but Keycard local OIDC is only supported on macOS (current: ${platform}).`,
        "Either remove the configuration or run on a macOS host.",
        `Remove: ${formatCliCommand("openclaw config unset gateway.identity.keycard")}`,
      ].join("\n"),
    );
    return result;
  }

  if (!exists(socketPath)) {
    result.errors.push(
      [
        `Keycard daemon socket not found at ${socketPath}.`,
        "Install and start the keycard-osx-oidcd daemon (see docs/identity/keycard-local-oidc.md).",
        `Configured zone: ${identity.zoneId}`,
      ].join("\n"),
    );
  } else {
    const dir = path.dirname(socketPath);
    result.infos.push(`Daemon socket present at ${socketPath} (dir ${dir}).`);
  }

  const mappings = effectiveProviderMappings(identity);
  const mappingSummary = Object.entries(mappings)
    .map(([provider, entry]) => `${provider}=${entry.resource}`)
    .join(", ");
  result.infos.push(
    `Configured provider mappings: ${mappingSummary || "(none — Keycard will only resolve when explicitly configured)"}.`,
  );

  if (options.deep) {
    const discoverer =
      options.discoverMetadata ??
      ((zoneId: string) => defaultDiscover(zoneId, options.fetchImpl ?? globalThis.fetch));
    try {
      const metadata = await discoverer(identity.zoneId.trim());
      result.infos.push(`Token endpoint: ${metadata.token_endpoint}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.warnings.push(
        [
          `Keycard authorization-server discovery failed for zone ${identity.zoneId}: ${msg}`,
          "Token exchanges will fail until the zone is reachable.",
        ].join("\n"),
      );
    }
  }

  return result;
}

/**
 * Convenience adapter: run the doctor check and emit each line through the
 * supplied `note` helper using the existing doctor section conventions.
 */
export async function emitKeycardIdentityDoctor(
  cfg: OpenClawConfig | undefined,
  emit: DoctorNote,
  options: KeycardIdentityDoctorOptions = {},
): Promise<void> {
  const result = await runKeycardIdentityDoctor(cfg, options);
  if (!result.configured) {
    return;
  }
  for (const message of result.errors) {
    emit(message, "Keycard identity (error)");
  }
  for (const message of result.warnings) {
    emit(message, "Keycard identity (warning)");
  }
  if (result.errors.length === 0 && result.warnings.length === 0 && result.infos.length > 0) {
    emit(result.infos.join("\n"), "Keycard identity");
  }
}
