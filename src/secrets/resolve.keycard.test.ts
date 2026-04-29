/**
 * Verifies the `keycard` secrets source. The KeycardResolver itself is
 * exercised against macOS only; for cross-platform coverage we install a
 * stubbed resolver into the registry so the `keycard` branch in
 * `secrets/resolve.ts` can be reached on every platform.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearActiveKeycardResolverForTests,
  setActiveKeycardResolver,
} from "../identity/keycard/registry.js";
import type {
  KeycardResolveOutcome,
  KeycardResolver,
  ResolveOptions,
} from "../identity/keycard/resolver.js";
import {
  resolveSecretRefString,
  resolveSecretRefValue,
  resolveSecretRefValues,
  SecretProviderResolutionError,
  SecretRefResolutionError,
} from "./resolve.js";

type RecordedCall = { resource: string; agentId: string | undefined };

function makeStubResolver(params: {
  outcomesByResource?: Record<string, KeycardResolveOutcome>;
  defaultOutcome?: (resource: string, agentId: string | undefined) => KeycardResolveOutcome;
}): { resolver: KeycardResolver; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const map = params.outcomesByResource ?? {};
  const fallback =
    params.defaultOutcome ??
    ((resource: string): KeycardResolveOutcome => ({
      ok: true,
      accessToken: `token-${resource}`,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      resource,
    }));
  const resolver: KeycardResolver = {
    config: () => ({ zoneId: "test-zone" }),
    providerMappings: () => ({}),
    async resolveResource(resource: string, options?: ResolveOptions) {
      calls.push({ resource, agentId: options?.agentId });
      return map[resource] ?? fallback(resource, options?.agentId);
    },
    async resolveProvider(_providerId: string) {
      return { ok: false, reason: "no-mapping", message: "stub" };
    },
    async prefetch() {
      return [];
    },
    dispose() {},
  };
  return { resolver, calls };
}

function makeConfig(): OpenClawConfig {
  return {
    secrets: {
      providers: {
        keycard: { source: "keycard" },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("secrets resolve: keycard source", () => {
  afterEach(() => {
    clearActiveKeycardResolverForTests();
  });

  it("resolves a keycard ref to the broker's access token", async () => {
    const { resolver, calls } = makeStubResolver({});
    setActiveKeycardResolver(resolver);
    const value = await resolveSecretRefString(
      { source: "keycard", provider: "keycard", id: "urn:secret:claude-api" },
      { config: makeConfig() },
    );
    expect(value).toBe("token-urn:secret:claude-api");
    expect(calls).toEqual([{ resource: "urn:secret:claude-api", agentId: undefined }]);
  });

  it("forwards agentId from ResolveSecretRefOptions to the broker", async () => {
    const { resolver, calls } = makeStubResolver({});
    setActiveKeycardResolver(resolver);
    const value = await resolveSecretRefValue(
      { source: "keycard", provider: "keycard", id: "urn:secret:claude-api" },
      { config: makeConfig(), agentId: "researcher" },
    );
    expect(value).toBe("token-urn:secret:claude-api");
    expect(calls).toEqual([{ resource: "urn:secret:claude-api", agentId: "researcher" }]);
  });

  it("treats blank agentId as no agent (gateway-shared identity)", async () => {
    const { resolver, calls } = makeStubResolver({});
    setActiveKeycardResolver(resolver);
    await resolveSecretRefValue(
      { source: "keycard", provider: "keycard", id: "urn:secret:claude-api" },
      { config: makeConfig(), agentId: "  " },
    );
    expect(calls).toEqual([{ resource: "urn:secret:claude-api", agentId: undefined }]);
  });

  it("errors with SecretProviderResolutionError when the keycard resolver is missing", async () => {
    clearActiveKeycardResolverForTests();
    await expect(
      resolveSecretRefValue(
        { source: "keycard", provider: "keycard", id: "urn:secret:claude-api" },
        { config: makeConfig() },
      ),
    ).rejects.toBeInstanceOf(SecretProviderResolutionError);
  });

  it("surfaces broker not-darwin failures as SecretRefResolutionError", async () => {
    const { resolver } = makeStubResolver({
      outcomesByResource: {
        "urn:secret:claude-api": {
          ok: false,
          reason: "not-darwin",
          message: "off platform",
        },
      },
    });
    setActiveKeycardResolver(resolver);
    await expect(
      resolveSecretRefValue(
        { source: "keycard", provider: "keycard", id: "urn:secret:claude-api" },
        { config: makeConfig() },
      ),
    ).rejects.toBeInstanceOf(SecretRefResolutionError);
  });

  it("rejects empty resource ids", async () => {
    const { resolver } = makeStubResolver({});
    setActiveKeycardResolver(resolver);
    await expect(
      resolveSecretRefValue(
        { source: "keycard", provider: "keycard", id: "   " },
        { config: makeConfig() },
      ),
    ).rejects.toThrow(/empty/);
  });

  it("batches multiple keycard refs to the same broker (sequential)", async () => {
    const { resolver, calls } = makeStubResolver({});
    setActiveKeycardResolver(resolver);
    const map = await resolveSecretRefValues(
      [
        { source: "keycard", provider: "keycard", id: "urn:secret:claude-api" },
        { source: "keycard", provider: "keycard", id: "urn:secret:openai-api" },
      ],
      { config: makeConfig(), agentId: "coder" },
    );
    expect(map.size).toBe(2);
    expect(map.get("keycard:keycard:urn:secret:claude-api")).toBe("token-urn:secret:claude-api");
    expect(map.get("keycard:keycard:urn:secret:openai-api")).toBe("token-urn:secret:openai-api");
    expect(calls).toEqual([
      { resource: "urn:secret:claude-api", agentId: "coder" },
      { resource: "urn:secret:openai-api", agentId: "coder" },
    ]);
  });

  it("rejects malformed resource ids before contacting the broker", async () => {
    const { resolver, calls } = makeStubResolver({});
    setActiveKeycardResolver(resolver);
    await expect(
      resolveSecretRefValue(
        { source: "keycard", provider: "keycard", id: "has space" },
        { config: makeConfig() },
      ),
    ).rejects.toBeInstanceOf(SecretRefResolutionError);
    expect(calls).toHaveLength(0);
  });
});

describe("secrets resolve: keycard provider config mismatch", () => {
  beforeEach(() => {
    clearActiveKeycardResolverForTests();
  });

  it("complains when ref source mismatches provider source", async () => {
    const { resolver } = makeStubResolver({});
    setActiveKeycardResolver(resolver);
    const config = {
      secrets: {
        providers: {
          notkeycard: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig;
    await expect(
      resolveSecretRefValue(
        { source: "keycard", provider: "notkeycard", id: "urn:secret:claude-api" },
        { config },
      ),
    ).rejects.toBeInstanceOf(SecretProviderResolutionError);
  });
});
