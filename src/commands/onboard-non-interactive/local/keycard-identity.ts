/**
 * Non-interactive Keycard identity helpers.
 *
 * Used by the local onboarding command when the operator passes
 * `--keycard-zone-id` (and optional `--keycard-provider provider=resource`
 * repeatable flags). Built-in defaults from
 * `DEFAULT_KEYCARD_PROVIDER_RESOURCES` cover Anthropic + OpenAI when the
 * operator only supplies the zone id.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { KeycardProviderEntry } from "../../../identity/keycard/types.js";

export type KeycardProviderFlagParseResult = {
  providers: Record<string, KeycardProviderEntry>;
  errors: string[];
};

/**
 * Parse repeatable `provider=resource` flag values. Whitespace is trimmed;
 * blank entries are ignored; duplicates keep the last value (matching how
 * other repeatable onboard flags behave).
 */
export function parseKeycardProviderFlags(values: string[]): KeycardProviderFlagParseResult {
  const providers: Record<string, KeycardProviderEntry> = {};
  const errors: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq <= 0 || eq === raw.length - 1) {
      errors.push(
        `Invalid --keycard-provider value "${raw}". Expected "provider=resource" (for example "anthropic=urn:secret:claude-api").`,
      );
      continue;
    }
    const provider = raw.slice(0, eq).trim();
    const resource = raw.slice(eq + 1).trim();
    if (!provider || !resource) {
      errors.push(
        `Invalid --keycard-provider value "${raw}". Expected "provider=resource" (for example "anthropic=urn:secret:claude-api").`,
      );
      continue;
    }
    providers[provider] = { resource };
  }
  return { providers, errors };
}

/**
 * Merge a Keycard identity block into `gateway.identity.keycard`, leaving
 * other gateway/identity properties untouched. Empty zone ids are rejected
 * by the caller; we only normalize trimming here.
 */
export function applyKeycardIdentityFromOptions(
  config: OpenClawConfig,
  params: {
    zoneId: string;
    providers?: Record<string, KeycardProviderEntry>;
  },
): OpenClawConfig {
  const zoneId = params.zoneId.trim();
  if (!zoneId) {
    return config;
  }
  const providers =
    params.providers && Object.keys(params.providers).length > 0
      ? Object.fromEntries(
          Object.entries(params.providers).map(([provider, entry]) => [
            provider,
            { resource: entry.resource.trim() },
          ]),
        )
      : undefined;
  return {
    ...config,
    gateway: {
      ...(config.gateway ?? {}),
      identity: {
        ...(config.gateway?.identity ?? {}),
        keycard: {
          zoneId,
          ...(providers ? { providers } : {}),
        },
      },
    },
  };
}
