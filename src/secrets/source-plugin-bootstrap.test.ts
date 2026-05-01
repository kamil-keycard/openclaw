import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import { bootstrapPluginSecretSources } from "./source-plugin-bootstrap.js";
import {
  clearSecretSourceRegistry,
  listSecretSourceAliases,
  registerSecretSourceFactory,
  resolveSecretSourceAlias,
} from "./source-plugin-registry.js";
import type { SecretSourceFactory } from "./source-plugin.js";

const REGISTRY_KEY = Symbol.for("openclaw.secretSourceRegistryState");

afterEach(() => {
  clearSecretSourceRegistry();
  const g = globalThis as Record<symbol, unknown>;
  delete g[REGISTRY_KEY];
});

function makeStaticFactory(overrides?: Partial<SecretSourceFactory>): SecretSourceFactory {
  const factory: SecretSourceFactory = {
    name: "static-test",
    configSchema: z
      .object({
        source: z.literal("plugin"),
        plugin: z.literal("static-test"),
        resources: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    create(_parsed, ctx) {
      return {
        name: "static-test",
        alias: ctx.alias,
        async resolve(refs) {
          return refs.map((ref) => ({ ok: true, value: `static:${ref.id}` }));
        },
      };
    },
  };
  return { ...factory, ...overrides };
}

function makeConfig(
  providers: NonNullable<NonNullable<OpenClawConfig["secrets"]>["providers"]>,
): OpenClawConfig {
  return { secrets: { providers } } as unknown as OpenClawConfig;
}

describe("bootstrapPluginSecretSources", () => {
  it("binds aliases for registered plugin sources", async () => {
    registerSecretSourceFactory(makeStaticFactory(), {
      ownerPluginId: "static-test-plugin",
    });

    const config = makeConfig({
      keycard: { source: "plugin", plugin: "static-test" },
    });

    const result = await bootstrapPluginSecretSources(config);

    expect(result.bound).toEqual(["keycard"]);
    expect(result.diagnostics).toEqual([]);

    const lookup = resolveSecretSourceAlias("keycard");
    expect(lookup.ok).toBe(true);
  });

  it("warns and skips when the plugin is not registered", async () => {
    const config = makeConfig({
      keycard: { source: "plugin", plugin: "static-test" },
    });

    const result = await bootstrapPluginSecretSources(config);

    expect(result.bound).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.level).toBe("warn");
    expect(result.diagnostics[0]?.alias).toBe("keycard");
    expect(result.diagnostics[0]?.pluginName).toBe("static-test");
    expect(resolveSecretSourceAlias("keycard")).toEqual({ ok: false, reason: "no-binding" });
  });

  it("errors when the plugin's Zod rejects the alias config", async () => {
    registerSecretSourceFactory(makeStaticFactory());

    const config = makeConfig({
      keycard: {
        source: "plugin",
        plugin: "static-test",
        resources: { ok: "fine", bad: 42 } as unknown as Record<string, string>,
      },
    });

    const result = await bootstrapPluginSecretSources(config);

    expect(result.bound).toEqual([]);
    const diag = result.diagnostics[0];
    expect(diag?.level).toBe("error");
    expect(diag?.message).toMatch(/rejected the alias config/);
  });

  it("warns and skips when diagnose() reports unavailable", async () => {
    registerSecretSourceFactory(
      makeStaticFactory({
        create(_parsed, ctx) {
          return {
            name: "static-test",
            alias: ctx.alias,
            async resolve(refs) {
              return refs.map(() => ({ ok: true, value: "x" }));
            },
            async diagnose() {
              return { ok: false, message: "issuer offline" };
            },
          };
        },
      }),
    );

    const config = makeConfig({
      keycard: { source: "plugin", plugin: "static-test" },
    });

    const result = await bootstrapPluginSecretSources(config);

    expect(result.bound).toEqual([]);
    expect(result.diagnostics[0]?.level).toBe("warn");
    expect(result.diagnostics[0]?.message).toMatch(/issuer offline/);
    expect(resolveSecretSourceAlias("keycard")).toEqual({ ok: false, reason: "no-binding" });
  });

  it("can skip diagnose() when runDiagnose is false", async () => {
    registerSecretSourceFactory(
      makeStaticFactory({
        create(_parsed, ctx) {
          return {
            name: "static-test",
            alias: ctx.alias,
            async resolve(refs) {
              return refs.map(() => ({ ok: true, value: "x" }));
            },
            async diagnose() {
              return { ok: false, message: "would skip" };
            },
          };
        },
      }),
    );

    const config = makeConfig({
      keycard: { source: "plugin", plugin: "static-test" },
    });

    const result = await bootstrapPluginSecretSources(config, { runDiagnose: false });

    expect(result.bound).toEqual(["keycard"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("unbinds aliases that disappear on a subsequent bootstrap", async () => {
    registerSecretSourceFactory(makeStaticFactory());

    await bootstrapPluginSecretSources(
      makeConfig({
        first: { source: "plugin", plugin: "static-test" },
        second: { source: "plugin", plugin: "static-test" },
      }),
    );
    expect(listSecretSourceAliases()).toEqual(["first", "second"]);

    await bootstrapPluginSecretSources(
      makeConfig({
        first: { source: "plugin", plugin: "static-test" },
      }),
    );
    expect(listSecretSourceAliases()).toEqual(["first"]);
  });

  it("forwards plugin entry config to factory.create", async () => {
    let received: unknown;
    registerSecretSourceFactory(
      makeStaticFactory({
        create(_parsed, ctx) {
          received = ctx.pluginEntryConfig;
          return {
            name: "static-test",
            alias: ctx.alias,
            async resolve(refs) {
              return refs.map(() => ({ ok: true, value: "x" }));
            },
          };
        },
      }),
    );

    await bootstrapPluginSecretSources(
      makeConfig({
        keycard: { source: "plugin", plugin: "static-test" },
      }),
      {
        pluginEntryConfig: (name) =>
          name === "static-test" ? { identity: { zoneId: "zone_x" } } : undefined,
      },
    );

    expect(received).toEqual({ identity: { zoneId: "zone_x" } });
  });

  it("ignores non-plugin secret provider entries", async () => {
    registerSecretSourceFactory(makeStaticFactory());

    const result = await bootstrapPluginSecretSources(
      makeConfig({
        legacy: { source: "env", allowlist: ["FOO"] },
        keycard: { source: "plugin", plugin: "static-test" },
      }),
    );

    expect(result.bound).toEqual(["keycard"]);
    expect(result.diagnostics).toEqual([]);
  });
});
