import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import {
  clearSecretSourceRegistry,
  registerSecretSourceFactory,
  resolveSecretSourceAlias,
} from "../secrets/source-plugin-registry.js";
import type { SecretSourceFactory } from "../secrets/source-plugin.js";
import {
  createRuntimeSecretsActivator,
  prepareGatewayStartupConfig,
} from "./server-startup-config.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const REGISTRY_KEY = Symbol.for("openclaw.secretSourceRegistryState");

afterEach(() => {
  clearSecretSourceRegistry();
  const g = globalThis as Record<symbol, unknown>;
  delete g[REGISTRY_KEY];
});

function gatewayTokenConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    gateway: {
      ...config.gateway,
      auth: {
        ...config.gateway?.auth,
        mode: config.gateway?.auth?.mode ?? "token",
        token: config.gateway?.auth?.token ?? "startup-test-token",
      },
    },
  };
}

function buildSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  return buildTestConfigSnapshot({
    path: "/tmp/openclaw-plugin-secrets-test.json",
    exists: true,
    raw,
    parsed: config,
    valid: true,
    config,
    issues: [],
    legacyIssues: [],
  });
}

function preparedSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: config,
    config,
    authStores: [],
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  };
}

function makeStaticFactory(overrides?: Partial<SecretSourceFactory>): SecretSourceFactory {
  const factory: SecretSourceFactory = {
    name: "static-test",
    configSchema: z
      .object({
        source: z.literal("plugin"),
        plugin: z.literal("static-test"),
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

describe("prepareGatewayStartupConfig beforeFinalActivate hook", () => {
  it("calls beforeFinalActivate between auth bootstrap and final activate", async () => {
    const callOrder: string[] = [];
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => {
      callOrder.push("activate");
      return preparedSnapshot(config);
    });

    const result = await prepareGatewayStartupConfig({
      configSnapshot: buildSnapshot(gatewayTokenConfig({})),
      activateRuntimeSecrets: createRuntimeSecretsActivator({
        logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        emitStateEvent: vi.fn(),
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot: vi.fn(),
      }),
      beforeFinalActivate: async (_config) => {
        callOrder.push("beforeFinalActivate");
      },
    });

    expect(result.cfg).toBeDefined();
    expect(callOrder).toEqual(["beforeFinalActivate", "activate"]);
  });

  it("binds plugin secret source aliases when beforeFinalActivate bootstraps them", async () => {
    registerSecretSourceFactory(makeStaticFactory(), { ownerPluginId: "static-test-plugin" });

    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));

    const { bootstrapPluginSecretSources } = await import("../secrets/source-plugin-bootstrap.js");

    await prepareGatewayStartupConfig({
      configSnapshot: buildSnapshot(
        gatewayTokenConfig({
          secrets: {
            providers: {
              myalias: { source: "plugin", plugin: "static-test" },
            },
          },
        }),
      ),
      activateRuntimeSecrets: createRuntimeSecretsActivator({
        logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        emitStateEvent: vi.fn(),
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot: vi.fn(),
      }),
      beforeFinalActivate: async (config) => {
        await bootstrapPluginSecretSources(config, {
          pluginEntryConfig: (name) => config.plugins?.entries?.[name]?.config,
        });
      },
    });

    const lookup = resolveSecretSourceAlias("myalias");
    expect(lookup.ok).toBe(true);
  });

  it("skips activation gracefully when no plugin factory is registered", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
    const { bootstrapPluginSecretSources } = await import("../secrets/source-plugin-bootstrap.js");
    let diagnostics: Array<{ level: string; alias: string }> = [];

    await prepareGatewayStartupConfig({
      configSnapshot: buildSnapshot(
        gatewayTokenConfig({
          secrets: {
            providers: {
              missing: { source: "plugin", plugin: "nonexistent" },
            },
          },
        }),
      ),
      activateRuntimeSecrets: createRuntimeSecretsActivator({
        logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        emitStateEvent: vi.fn(),
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot: vi.fn(),
      }),
      beforeFinalActivate: async (config) => {
        const result = await bootstrapPluginSecretSources(config, {
          pluginEntryConfig: (name) => config.plugins?.entries?.[name]?.config,
        });
        diagnostics = result.diagnostics;
      },
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe("warn");
    expect(diagnostics[0]?.alias).toBe("missing");
    expect(resolveSecretSourceAlias("missing")).toEqual({ ok: false, reason: "no-binding" });
  });
});
