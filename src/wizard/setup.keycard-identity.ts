/**
 * Optional Keycard identity step shown early in the setup wizard.
 *
 * Goal:
 *  - Let operators paste a Keycard zone id once and have downstream
 *    per-provider API-key prompts skip themselves automatically (via
 *    `providerHasKeycardMapping`).
 *  - Built-in defaults cover Anthropic + OpenAI; users can extend the
 *    mapping later by editing config or via doctor.
 *  - Skipping is always supported and leaves the existing onboarding flow
 *    completely unchanged.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_KEYCARD_PROVIDER_RESOURCES,
  effectiveProviderMappings,
  type KeycardIdentityConfig,
} from "../identity/keycard/types.js";
import type { WizardPrompter } from "./prompts.js";

export type KeycardIdentitySetupResult = {
  /** Config with `gateway.identity.keycard` populated (or unchanged on skip). */
  config: OpenClawConfig;
  /** Mapping that was installed (empty if skipped). */
  providers: Record<string, { resource: string }>;
  /** True when the user enabled Keycard during this wizard run. */
  enabled: boolean;
};

function readExistingZoneId(config: OpenClawConfig): string | undefined {
  const id = config.gateway?.identity?.keycard?.zoneId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

function applyKeycardIdentityConfig(
  config: OpenClawConfig,
  identity: KeycardIdentityConfig,
): OpenClawConfig {
  const providers = identity.providers
    ? Object.fromEntries(
        Object.entries(identity.providers).map(([provider, entry]) => [
          provider,
          { resource: entry.resource.trim() },
        ]),
      )
    : undefined;
  const next: OpenClawConfig = {
    ...config,
    gateway: {
      ...(config.gateway ?? {}),
      identity: {
        ...(config.gateway?.identity ?? {}),
        keycard: {
          zoneId: identity.zoneId.trim(),
          ...(identity.socketPath ? { socketPath: identity.socketPath } : {}),
          ...(identity.audience ? { audience: identity.audience } : {}),
          ...(providers ? { providers } : {}),
        },
      },
    },
  };
  return next;
}

/**
 * Prompt the user for an optional Keycard zone id. Returns the resulting
 * config and the effective provider mapping (after layering defaults).
 *
 * The flow is intentionally minimal:
 *  - Single yes/no on whether to enable Keycard.
 *  - Single text input for the zone id (validated as non-empty).
 *  - Built-in defaults are applied automatically; advanced overrides go
 *    through manual config edits, not the wizard.
 */
export async function promptKeycardIdentitySetup(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<KeycardIdentitySetupResult> {
  const { config, prompter } = params;
  const existing = readExistingZoneId(config);

  if (process.platform !== "darwin") {
    if (existing) {
      await prompter.note(
        `Keycard identity is configured (zone ${existing}) but only takes effect on macOS. The current host will fall back to legacy auth.`,
        "Keycard identity",
      );
    }
    return {
      config,
      providers: existing ? effectiveProviderMappings(config.gateway?.identity?.keycard) : {},
      enabled: false,
    };
  }

  if (existing) {
    await prompter.note(`Currently configured zone: ${existing}`, "Keycard identity");
  }
  const enable = await prompter.confirm({
    message: existing
      ? "Keep using Keycard for provider credentials?"
      : "Use Keycard to provide provider credentials (Anthropic, OpenAI)?",
    initialValue: existing !== undefined,
  });

  if (!enable) {
    return { config, providers: {}, enabled: false };
  }

  const zoneIdRaw = await prompter.text({
    message: "Keycard zone id",
    placeholder: "e.g. o36mbsre94s2vlt8x5jq6nbxs0",
    initialValue: existing ?? "",
    validate: (value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return "Zone id is required.";
      }
      return undefined;
    },
  });
  const zoneId = zoneIdRaw.trim();

  const identity: KeycardIdentityConfig = {
    zoneId,
    ...(config.gateway?.identity?.keycard?.socketPath
      ? { socketPath: config.gateway.identity.keycard.socketPath }
      : {}),
    ...(config.gateway?.identity?.keycard?.audience
      ? { audience: config.gateway.identity.keycard.audience }
      : {}),
    ...(config.gateway?.identity?.keycard?.providers
      ? { providers: config.gateway.identity.keycard.providers }
      : {}),
  };
  const nextConfig = applyKeycardIdentityConfig(config, identity);
  const providers = effectiveProviderMappings(identity);

  const summary = Object.entries(providers)
    .map(([provider, entry]) => `- ${provider} → ${entry.resource}`)
    .join("\n");
  const defaultedProviders = Object.entries(DEFAULT_KEYCARD_PROVIDER_RESOURCES)
    .filter(([provider]) => !identity.providers || !identity.providers[provider])
    .map(([provider]) => provider);
  const defaultsLine = defaultedProviders.length
    ? `\nDefaults applied for: ${defaultedProviders.join(", ")}.`
    : "";
  await prompter.note(`Keycard zone configured.\n${summary}${defaultsLine}`, "Keycard identity");

  return { config: nextConfig, providers, enabled: true };
}
