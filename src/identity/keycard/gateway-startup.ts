import {
  registerKeycardProviderLookup,
  type KeycardProviderLookup,
} from "../../agents/model-auth-runtime-shared.js";
/**
 * Gateway startup integration for the Keycard local-OIDC identity resolver.
 *
 * Called once during gateway boot (after config + secrets are settled).
 * Decisions:
 *  - Feature is opt-in via `gateway.identity.keycard.zoneId`.
 *  - macOS-only Phase 1: off-macOS we log a single WARN and skip wiring.
 *  - Resolution is lazy: we only construct the resolver and register the
 *    model-auth lookup. The first model call mints the JWT and exchanges it;
 *    the resolver's per-resource TTL + single-flight cache handles reuse.
 *    No network I/O at boot — keeps gateway startup fast and avoids flaking
 *    on providers the operator may never use this session.
 *  - Failures are non-fatal: agents still start; resolution simply errors at
 *    first model call if the daemon/Keycard are unreachable.
 */
import type { GatewayKeycardIdentityConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActiveKeycardResolver } from "./registry.js";
import { createKeycardResolver, type KeycardResolver } from "./resolver.js";

export type GatewayKeycardStartupLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  debug?: (message: string) => void;
};

export type GatewayKeycardStartupResult = {
  installed: boolean;
  reason?: "not-configured" | "not-darwin" | "init-failed";
  resolver?: KeycardResolver;
};

function readIdentityConfig(
  cfg: OpenClawConfig | undefined,
): GatewayKeycardIdentityConfig | undefined {
  const identity = cfg?.gateway?.identity?.keycard;
  if (!identity || typeof identity.zoneId !== "string" || identity.zoneId.trim().length === 0) {
    return undefined;
  }
  return identity;
}

function buildProviderLookup(resolver: KeycardResolver): KeycardProviderLookup {
  return async (provider) => {
    const outcome = await resolver.resolveProvider(provider);
    if (outcome.ok) {
      return {
        ok: true,
        apiKey: outcome.accessToken,
        source: `keycard:${outcome.resource}`,
      };
    }
    return { ok: false, reason: outcome.reason, message: outcome.message };
  };
}

/**
 * Initialize the Keycard resolver from the active gateway config and warm
 * caches. Returns a tagged result so the gateway can log the outcome through
 * its existing startup tracer.
 */
export async function setupKeycardIdentityForGateway(params: {
  config: OpenClawConfig;
  log: GatewayKeycardStartupLog;
}): Promise<GatewayKeycardStartupResult> {
  const identity = readIdentityConfig(params.config);
  if (!identity) {
    setActiveKeycardResolver(undefined);
    registerKeycardProviderLookup(undefined);
    return { installed: false, reason: "not-configured" };
  }

  if (process.platform !== "darwin") {
    params.log.warn(
      "gateway.identity.keycard is configured but local OIDC issuer is only supported on macOS; falling back to legacy auth.",
    );
    setActiveKeycardResolver(undefined);
    registerKeycardProviderLookup(undefined);
    return { installed: false, reason: "not-darwin" };
  }

  let resolver: KeycardResolver;
  try {
    resolver = createKeycardResolver({
      identity: {
        zoneId: identity.zoneId,
        socketPath: identity.socketPath,
        audience: identity.audience,
        providers: identity.providers,
      },
    });
  } catch (err) {
    params.log.warn(
      `Failed to initialize Keycard resolver: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { installed: false, reason: "init-failed" };
  }

  setActiveKeycardResolver(resolver);
  registerKeycardProviderLookup(buildProviderLookup(resolver));

  const mappings = resolver.providerMappings();
  const providerSummary = Object.entries(mappings)
    .map(([provider, entry]) => `${provider}=${entry.resource}`)
    .join(", ");
  params.log.info(
    `Keycard identity enabled for zone ${identity.zoneId} (${providerSummary || "no provider mappings"}). Tokens are minted lazily on first model call.`,
  );

  return { installed: true, resolver };
}
