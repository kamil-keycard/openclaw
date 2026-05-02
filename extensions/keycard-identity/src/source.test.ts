import { describe, expect, it, vi } from "vitest";
import type { KeycardAliasConfig, KeycardPluginConfig } from "./schema.js";
import { createKeycardSecretSourceFactory } from "./source.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

type FetchSpy = {
  calls: { url: string; init: RequestInit }[];
  fetch: typeof fetch;
};

function makeFetchSpy(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchSpy {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return await respond(url, init);
  };
  return { calls, fetch: impl as typeof fetch };
}

function makeAliasConfig(overrides?: Partial<KeycardAliasConfig>): KeycardAliasConfig {
  return {
    source: "plugin",
    plugin: "keycard-identity",
    resources: {
      "openai-api-key": { resource: "https://api.openai.com" },
      "anthropic-api-key": {
        resource: "https://api.anthropic.com",
        scopes: ["inference:write"],
      },
    },
    ...overrides,
  };
}

function makePluginConfig(token = "static-assertion"): KeycardPluginConfig {
  return {
    identity: {
      zoneId: "zone_abc123",
      method: {
        kind: "workload-identity",
        source: { type: "static-test", token },
      },
    },
  };
}

const DEFAULT_DISCOVERY_BODY = {
  issuer: "https://zone_abc123.keycard.cloud",
  token_endpoint: "https://zone_abc123.keycard.cloud/oauth/token",
};

describe("createKeycardSecretSourceFactory", () => {
  it("exposes the keycard-identity name and validates alias configs", async () => {
    const factory = createKeycardSecretSourceFactory({ pluginConfig: makePluginConfig() });
    expect(factory.name).toBe("keycard-identity");
    const parsed = factory.configSchema.parse({
      source: "plugin",
      plugin: "keycard-identity",
      resources: { "id-a": { resource: "https://api.example" } },
    });
    const source = await factory.create(parsed, { alias: "keycard" });
    expect(source.name).toBe("keycard-identity");
    expect(source.alias).toBe("keycard");
  });

  it("throws when no identity is available on the plugin or alias", async () => {
    const factory = createKeycardSecretSourceFactory();
    const parsed = factory.configSchema.parse(makeAliasConfig());
    await expect(factory.create(parsed, { alias: "keycard" })).rejects.toThrow(
      /no identity configured/,
    );
  });

  it("reads identity from the alias override when pluginConfig is missing", async () => {
    const factory = createKeycardSecretSourceFactory();
    const parsed = factory.configSchema.parse(
      makeAliasConfig({
        identity: {
          zoneId: "zone_alias",
          method: {
            kind: "workload-identity",
            source: { type: "static-test", token: "alias-assertion" },
          },
        },
      }),
    );
    const source = await factory.create(parsed, { alias: "keycard" });
    expect(source.alias).toBe("keycard");
  });

  it("reads identity from ctx.pluginEntryConfig when pluginConfig option is missing", async () => {
    const factory = createKeycardSecretSourceFactory();
    const parsed = factory.configSchema.parse(makeAliasConfig());
    const source = await factory.create(parsed, {
      alias: "keycard",
      pluginEntryConfig: makePluginConfig(),
    });
    expect(source.alias).toBe("keycard");
  });
});

describe("KeycardSecretSource.resolve", () => {
  it("discovers the token endpoint once and exchanges for each resource", async () => {
    let tokenCounter = 0;
    const spy = makeFetchSpy(async (url) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse(DEFAULT_DISCOVERY_BODY);
      }
      tokenCounter += 1;
      return jsonResponse({
        access_token: `sk-token-${tokenCounter}`,
        token_type: "Bearer",
        expires_in: 300,
      });
    });
    const factory = createKeycardSecretSourceFactory({
      pluginConfig: makePluginConfig(),
      fetchImpl: spy.fetch,
      now: () => 1_000,
    });
    const parsed = factory.configSchema.parse(makeAliasConfig());
    const source = await factory.create(parsed, { alias: "keycard" });

    const outcomes = await source.resolve([{ id: "openai-api-key" }, { id: "anthropic-api-key" }]);

    const discoveryCalls = spy.calls.filter((c) =>
      c.url.endsWith("/.well-known/oauth-authorization-server"),
    );
    expect(discoveryCalls).toHaveLength(1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({
      ok: true,
      value: "sk-token-1",
      expiresAt: 1_000 + 300_000,
    });
    expect(outcomes[1]).toMatchObject({
      ok: true,
      value: "sk-token-2",
      expiresAt: 1_000 + 300_000,
    });
  });

  it("returns not-found when the id is missing from the resource catalog", async () => {
    const spy = makeFetchSpy(async () => jsonResponse(DEFAULT_DISCOVERY_BODY));
    const factory = createKeycardSecretSourceFactory({
      pluginConfig: makePluginConfig(),
      fetchImpl: spy.fetch,
    });
    const parsed = factory.configSchema.parse(makeAliasConfig());
    const source = await factory.create(parsed, { alias: "keycard" });

    const outcomes = await source.resolve([{ id: "unknown" }]);
    expect(outcomes[0]).toEqual({
      ok: false,
      reason: "not-found",
      message: expect.stringMatching(/no resource entry/),
    });
  });

  it("caches successful exchanges until the refresh skew window", async () => {
    let tokenCalls = 0;
    const spy = makeFetchSpy(async (url) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse(DEFAULT_DISCOVERY_BODY);
      }
      tokenCalls += 1;
      return jsonResponse({
        access_token: `sk-${tokenCalls}`,
        token_type: "Bearer",
        expires_in: 300,
      });
    });
    let now = 1_000;
    const factory = createKeycardSecretSourceFactory({
      pluginConfig: makePluginConfig(),
      fetchImpl: spy.fetch,
      now: () => now,
      tokenRefreshSkewMs: 60_000,
    });
    const parsed = factory.configSchema.parse(makeAliasConfig());
    const source = await factory.create(parsed, { alias: "keycard" });

    const first = await source.resolve([{ id: "openai-api-key" }]);
    expect(first[0]).toMatchObject({ ok: true, value: "sk-1" });
    expect(tokenCalls).toBe(1);

    // Bump time forward but still within the fresh window.
    now = 1_000 + 100_000;
    const second = await source.resolve([{ id: "openai-api-key" }]);
    expect(second[0]).toMatchObject({ ok: true, value: "sk-1" });
    expect(tokenCalls).toBe(1);

    // Move inside the refresh skew → re-exchange.
    now = 1_000 + 300_000 - 30_000;
    const third = await source.resolve([{ id: "openai-api-key" }]);
    expect(third[0]).toMatchObject({ ok: true, value: "sk-2" });
    expect(tokenCalls).toBe(2);
  });

  it("coalesces concurrent resolves for the same id via single-flight", async () => {
    let tokenResolver: ((body: unknown) => void) | undefined;
    let tokenCalls = 0;
    const spy = makeFetchSpy(async (url) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse(DEFAULT_DISCOVERY_BODY);
      }
      tokenCalls += 1;
      return await new Promise<Response>((resolve) => {
        tokenResolver = (body: unknown) => resolve(jsonResponse(body));
      });
    });
    const factory = createKeycardSecretSourceFactory({
      pluginConfig: makePluginConfig(),
      fetchImpl: spy.fetch,
      now: () => 1_000,
    });
    const parsed = factory.configSchema.parse(makeAliasConfig());
    const source = await factory.create(parsed, { alias: "keycard" });

    const a = source.resolve([{ id: "openai-api-key" }]);
    const b = source.resolve([{ id: "openai-api-key" }]);
    // Allow the in-flight pendings to register before releasing.
    await new Promise((resolve) => setImmediate(resolve));
    expect(typeof tokenResolver).toBe("function");
    tokenResolver!({ access_token: "sk-shared", token_type: "Bearer", expires_in: 300 });

    const [first, second] = await Promise.all([a, b]);
    expect(first[0]).toMatchObject({ ok: true, value: "sk-shared" });
    expect(second[0]).toMatchObject({ ok: true, value: "sk-shared" });
    expect(tokenCalls).toBe(1);
  });

  it("maps OAuth errors to tagged failure outcomes", async () => {
    const spy = makeFetchSpy(async (url) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse(DEFAULT_DISCOVERY_BODY);
      }
      return new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "expired assertion" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });
    const factory = createKeycardSecretSourceFactory({
      pluginConfig: makePluginConfig(),
      fetchImpl: spy.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });
    const parsed = factory.configSchema.parse(makeAliasConfig());
    const source = await factory.create(parsed, { alias: "keycard" });

    const outcomes = await source.resolve([{ id: "openai-api-key" }]);
    expect(outcomes[0]).toMatchObject({
      ok: false,
      reason: "denied",
      message: expect.stringMatching(/invalid_grant/),
    });
  });

  it("diagnose() surfaces discovery failures as tagged unavailable", async () => {
    const spy = makeFetchSpy(async () => new Response("no", { status: 503 }));
    const factory = createKeycardSecretSourceFactory({
      pluginConfig: makePluginConfig(),
      fetchImpl: spy.fetch,
    });
    const parsed = factory.configSchema.parse(makeAliasConfig());
    const source = await factory.create(parsed, { alias: "keycard" });

    const result = await source.diagnose!();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/discovery failed/);
    }
  });

  it("includes the resource, audience, and scopes in the exchange request", async () => {
    const spy = makeFetchSpy(async (url) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse(DEFAULT_DISCOVERY_BODY);
      }
      return jsonResponse({
        access_token: "sk-detail",
        token_type: "Bearer",
        expires_in: 300,
      });
    });
    const factory = createKeycardSecretSourceFactory({
      pluginConfig: makePluginConfig(),
      fetchImpl: spy.fetch,
    });
    const parsed = factory.configSchema.parse(
      makeAliasConfig({
        resources: {
          "anthropic-api-key": {
            resource: "https://api.anthropic.com",
            audience: "aud-anthropic",
            scopes: ["inference:write", "traces:read"],
          },
        },
      }),
    );
    const source = await factory.create(parsed, { alias: "keycard" });
    await source.resolve([{ id: "anthropic-api-key" }]);

    const tokenCall = spy.calls.find((c) => c.url.endsWith("/oauth/token"));
    expect(tokenCall).toBeDefined();
    const params = new URLSearchParams(tokenCall!.init.body as string);
    expect(params.get("resource")).toBe("https://api.anthropic.com");
    expect(params.get("audience")).toBe("aud-anthropic");
    expect(params.get("scope")).toBe("inference:write traces:read");
  });
});
