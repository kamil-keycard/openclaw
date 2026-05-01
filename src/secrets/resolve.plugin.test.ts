import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretRefResolveCache } from "./resolve-types.js";
import {
  DEFAULT_PLUGIN_SECRET_TTL_LEEWAY_MS,
  resolveSecretRefValue,
  resolveSecretRefValues,
  resolveSecretRefValueWithRefresh,
} from "./resolve.js";
import {
  bindSecretSourceAlias,
  clearSecretSourceRegistry,
  registerSecretSourceFactory,
} from "./source-plugin-registry.js";
import type { SecretSource, SecretSourceFactory, SecretSourceOutcome } from "./source-plugin.js";

const REGISTRY_KEY = Symbol.for("openclaw.secretSourceRegistryState");

afterEach(() => {
  clearSecretSourceRegistry();
  const g = globalThis as Record<symbol, unknown>;
  delete g[REGISTRY_KEY];
});

type StaticSourceParams = {
  alias?: string;
  values: Record<string, { value?: string; expiresAt?: number; outcome?: SecretSourceOutcome }>;
  /** Track resolve-call counts per id for refresh tests. */
  resolveCounts?: Record<string, number>;
};

function makeStaticSource(params: StaticSourceParams): SecretSource {
  const counts = params.resolveCounts ?? {};
  return {
    name: "static-test",
    alias: params.alias ?? "primary",
    async resolve(refs) {
      return refs.map((ref) => {
        counts[ref.id] = (counts[ref.id] ?? 0) + 1;
        const entry = params.values[ref.id];
        if (!entry) {
          return {
            ok: false,
            reason: "not-found",
            message: `no static value for ${ref.id}`,
          } satisfies SecretSourceOutcome;
        }
        if (entry.outcome) {
          return entry.outcome;
        }
        return {
          ok: true,
          value: entry.value ?? "ok",
          ...(typeof entry.expiresAt === "number" ? { expiresAt: entry.expiresAt } : {}),
        };
      });
    },
  };
}

function makeStaticFactory(): SecretSourceFactory {
  return {
    name: "static-test",
    configSchema: z
      .object({
        source: z.literal("plugin"),
        plugin: z.literal("static-test"),
      })
      .passthrough(),
    create(_parsed, ctx) {
      return makeStaticSource({ alias: ctx.alias, values: {} });
    },
  };
}

function makeConfigWithPluginAlias(alias = "primary"): OpenClawConfig {
  return {
    secrets: {
      providers: {
        [alias]: { source: "plugin", plugin: "static-test" },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("resolveSecretRefValues — plugin source dispatch", () => {
  it("returns the value for a bound plugin alias", async () => {
    bindSecretSourceAlias({
      alias: "primary",
      source: makeStaticSource({
        values: { "openai-api-key": { value: "sk-test-123" } },
      }),
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    const resolved = await resolveSecretRefValues(
      [{ source: "plugin", provider: "primary", id: "openai-api-key" }],
      { config },
    );

    expect(resolved.get("plugin:primary:openai-api-key")).toBe("sk-test-123");
  });

  it("batches multiple ids into a single source.resolve call", async () => {
    let calls = 0;
    bindSecretSourceAlias({
      alias: "primary",
      source: {
        name: "static-test",
        alias: "primary",
        async resolve(refs) {
          calls += 1;
          return refs.map((ref) => ({ ok: true, value: `${ref.id}:value` }));
        },
      },
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    const resolved = await resolveSecretRefValues(
      [
        { source: "plugin", provider: "primary", id: "first" },
        { source: "plugin", provider: "primary", id: "second" },
      ],
      { config },
    );

    expect(calls).toBe(1);
    expect(resolved.get("plugin:primary:first")).toBe("first:value");
    expect(resolved.get("plugin:primary:second")).toBe("second:value");
  });

  it("throws a provider error when alias has no binding", async () => {
    const config = makeConfigWithPluginAlias("primary");
    await expect(
      resolveSecretRefValues([{ source: "plugin", provider: "primary", id: "any" }], { config }),
    ).rejects.toThrow(/no plugin secret source is bound/);
  });

  it("throws a ref-scoped error for not-found outcomes", async () => {
    bindSecretSourceAlias({
      alias: "primary",
      source: makeStaticSource({ values: {} }),
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    await expect(
      resolveSecretRefValues([{ source: "plugin", provider: "primary", id: "missing" }], {
        config,
      }),
    ).rejects.toThrow(/did not find id/);
  });

  it("throws a provider error for unavailable outcomes", async () => {
    bindSecretSourceAlias({
      alias: "primary",
      source: makeStaticSource({
        values: {
          "openai-api-key": {
            outcome: {
              ok: false,
              reason: "unavailable",
              message: "issuer offline",
            },
          },
        },
      }),
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    await expect(
      resolveSecretRefValues([{ source: "plugin", provider: "primary", id: "openai-api-key" }], {
        config,
      }),
    ).rejects.toThrow(/reported unavailable/);
  });

  it("rejects mismatched outcome length", async () => {
    bindSecretSourceAlias({
      alias: "primary",
      source: {
        name: "static-test",
        alias: "primary",
        async resolve() {
          return [];
        },
      },
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    await expect(
      resolveSecretRefValues([{ source: "plugin", provider: "primary", id: "any" }], { config }),
    ).rejects.toThrow(/returned 0 outcomes for 1 requested/);
  });

  it("records expiresAt metadata on the cache", async () => {
    const expiresAt = Date.now() + 30_000;
    bindSecretSourceAlias({
      alias: "primary",
      source: makeStaticSource({
        values: { "openai-api-key": { value: "sk-test-123", expiresAt } },
      }),
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    const cache: SecretRefResolveCache = {};
    await resolveSecretRefValue(
      { source: "plugin", provider: "primary", id: "openai-api-key" },
      { config, cache },
    );

    const meta = cache.pluginRefMetaByRefKey?.get("plugin:primary:openai-api-key");
    expect(meta?.expiresAt).toBe(expiresAt);
    expect(typeof meta?.resolvedAt).toBe("number");
  });

  it("does not record expiresAt for non-plugin refs", async () => {
    const cache: SecretRefResolveCache = {};
    await expect(
      resolveSecretRefValue(
        { source: "env", provider: "default", id: "OPENCLAW_SOURCE_PLUGIN_TEST_VAR" },
        {
          config: {} as OpenClawConfig,
          cache,
          env: { OPENCLAW_SOURCE_PLUGIN_TEST_VAR: "value" },
        },
      ),
    ).resolves.toBe("value");

    expect(cache.pluginRefMetaByRefKey).toBeUndefined();
  });
});

describe("resolveSecretRefValueWithRefresh — TTL semantics", () => {
  it("returns the cached value before expiry minus leeway", async () => {
    const counts: Record<string, number> = {};
    bindSecretSourceAlias({
      alias: "primary",
      source: makeStaticSource({
        values: {
          "openai-api-key": {
            value: "sk-original",
            expiresAt: 10_000_000,
          },
        },
        resolveCounts: counts,
      }),
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    const cache: SecretRefResolveCache = {};

    const ref = { source: "plugin" as const, provider: "primary", id: "openai-api-key" };
    const first = await resolveSecretRefValueWithRefresh(ref, {
      config,
      cache,
      now: () => 9_000_000,
    });
    const second = await resolveSecretRefValueWithRefresh(ref, {
      config,
      cache,
      now: () => 9_000_000 + 1,
    });

    expect(first).toBe("sk-original");
    expect(second).toBe("sk-original");
    expect(counts["openai-api-key"]).toBe(1);
  });

  it("re-resolves when within leeway of expiry", async () => {
    let value = "sk-v1";
    let nextExpiresAt = 10_000_000;
    const counts: Record<string, number> = {};
    bindSecretSourceAlias({
      alias: "primary",
      source: {
        name: "static-test",
        alias: "primary",
        async resolve(refs) {
          counts[refs[0].id] = (counts[refs[0].id] ?? 0) + 1;
          return refs.map(() => ({
            ok: true as const,
            value,
            expiresAt: nextExpiresAt,
          }));
        },
      },
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    const cache: SecretRefResolveCache = {};
    const ref = { source: "plugin" as const, provider: "primary", id: "openai-api-key" };

    const first = await resolveSecretRefValueWithRefresh(ref, {
      config,
      cache,
      now: () => 9_500_000,
    });
    expect(first).toBe("sk-v1");

    value = "sk-v2";
    nextExpiresAt = 20_000_000;
    // Inside the default leeway window before the cached expiresAt (10_000_000)
    // → should refresh and return the new value.
    const refreshed = await resolveSecretRefValueWithRefresh(ref, {
      config,
      cache,
      now: () => 10_000_000 - DEFAULT_PLUGIN_SECRET_TTL_LEEWAY_MS / 2,
    });
    expect(refreshed).toBe("sk-v2");
    expect(counts["openai-api-key"]).toBe(2);
  });

  it("respects a custom leeway override", async () => {
    let value = "sk-v1";
    const counts: Record<string, number> = {};
    bindSecretSourceAlias({
      alias: "primary",
      source: {
        name: "static-test",
        alias: "primary",
        async resolve(refs) {
          counts[refs[0].id] = (counts[refs[0].id] ?? 0) + 1;
          return refs.map(() => ({
            ok: true as const,
            value,
            expiresAt: 10_000_000 + counts[refs[0].id] * 1_000,
          }));
        },
      },
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    const cache: SecretRefResolveCache = {};
    const ref = { source: "plugin" as const, provider: "primary", id: "openai-api-key" };

    await resolveSecretRefValueWithRefresh(ref, {
      config,
      cache,
      now: () => 9_990_000,
      leewayMs: 0,
    });
    expect(counts["openai-api-key"]).toBe(1);

    value = "sk-v2";
    // 5s before expiry, 0 leeway → still fresh.
    const stillFresh = await resolveSecretRefValueWithRefresh(ref, {
      config,
      cache,
      now: () => 10_000_995,
      leewayMs: 0,
    });
    expect(stillFresh).toBe("sk-v1");
    expect(counts["openai-api-key"]).toBe(1);
  });

  it("does not refresh when no expiresAt was reported", async () => {
    const counts: Record<string, number> = {};
    bindSecretSourceAlias({
      alias: "primary",
      source: makeStaticSource({
        values: { "openai-api-key": { value: "sk-permanent" } },
        resolveCounts: counts,
      }),
      factoryName: "static-test",
    });

    const config = makeConfigWithPluginAlias("primary");
    const cache: SecretRefResolveCache = {};
    const ref = { source: "plugin" as const, provider: "primary", id: "openai-api-key" };

    await resolveSecretRefValueWithRefresh(ref, { config, cache, now: () => 1 });
    await resolveSecretRefValueWithRefresh(ref, { config, cache, now: () => 1_000_000_000_000 });

    expect(counts["openai-api-key"]).toBe(1);
  });
});

describe("static-test factory", () => {
  it("registers and produces a usable source via factory.create", async () => {
    const factory = makeStaticFactory();
    registerSecretSourceFactory(factory, { ownerPluginId: "static-test-plugin" });

    const parsed = factory.configSchema.parse({
      source: "plugin",
      plugin: "static-test",
    });
    const source = await factory.create(parsed, { alias: "primary" });

    const outcomes = await source.resolve([{ id: "any" }]);
    expect(Array.isArray(outcomes)).toBe(true);
  });
});
