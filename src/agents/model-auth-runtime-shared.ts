import { normalizeSecretInput } from "../utils/normalize-secret-input.js";

const AWS_BEARER_ENV = "AWS_BEARER_TOKEN_BEDROCK";
const AWS_ACCESS_KEY_ENV = "AWS_ACCESS_KEY_ID";
const AWS_SECRET_KEY_ENV = "AWS_SECRET_ACCESS_KEY";
const AWS_PROFILE_ENV = "AWS_PROFILE";

export type ResolvedProviderAuthMode = "api-key" | "oauth" | "token" | "aws-sdk" | "keycard";

export type ResolvedProviderAuth = {
  apiKey?: string;
  profileId?: string;
  source: string;
  mode: ResolvedProviderAuthMode;
};

/**
 * Optional Keycard provider lookup. The gateway installs a real implementation
 * when `gateway.identity.keycard` is configured; everywhere else this stays
 * `undefined` so model-auth keeps its legacy behavior.
 *
 * Returning `undefined` (or a result that is not `ok`) lets the resolver fall
 * through to the existing auth chain without throwing.
 */
export type KeycardProviderLookup = (provider: string) => Promise<
  | undefined
  | {
      ok: true;
      apiKey: string;
      source: string;
    }
  | { ok: false; reason: string; message: string }
>;

let keycardProviderLookup: KeycardProviderLookup | undefined;

export function registerKeycardProviderLookup(lookup: KeycardProviderLookup | undefined): void {
  keycardProviderLookup = lookup;
}

export function getKeycardProviderLookup(): KeycardProviderLookup | undefined {
  return keycardProviderLookup;
}

export function resolveAwsSdkEnvVarName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[AWS_BEARER_ENV]?.trim()) {
    return AWS_BEARER_ENV;
  }
  if (env[AWS_ACCESS_KEY_ENV]?.trim() && env[AWS_SECRET_KEY_ENV]?.trim()) {
    return AWS_ACCESS_KEY_ENV;
  }
  if (env[AWS_PROFILE_ENV]?.trim()) {
    return AWS_PROFILE_ENV;
  }
  return undefined;
}

export function requireApiKey(auth: ResolvedProviderAuth, provider: string): string {
  const key = normalizeSecretInput(auth.apiKey);
  if (key) {
    return key;
  }
  throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth.mode}).`);
}
