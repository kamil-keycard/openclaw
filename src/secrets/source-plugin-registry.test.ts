import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bindSecretSourceAlias,
  clearSecretSourceRegistry,
  disposeSecretSourceAlias,
  listSecretSourceAliases,
  listSecretSourceFactoryNames,
  lookupSecretSourceFactory,
  registerSecretSourceFactory,
  resolveSecretSourceAlias,
} from "./source-plugin-registry.js";
import type { SecretSource, SecretSourceFactory } from "./source-plugin.js";

const REGISTRY_KEY = Symbol.for("openclaw.secretSourceRegistryState");

afterEach(() => {
  clearSecretSourceRegistry();
  const g = globalThis as Record<symbol, unknown>;
  delete g[REGISTRY_KEY];
});

function makeFactory(name: string): SecretSourceFactory {
  return {
    name,
    configSchema: z.object({}).passthrough(),
    create(_parsed, ctx) {
      return makeSource(name, ctx.alias);
    },
  };
}

function makeSource(name: string, alias: string, value = "stub"): SecretSource {
  return {
    name,
    alias,
    async resolve(refs) {
      return refs.map(() => ({ ok: true as const, value }));
    },
  };
}

describe("secret source factory registry", () => {
  it("starts empty", () => {
    expect(listSecretSourceFactoryNames()).toEqual([]);
    expect(listSecretSourceAliases()).toEqual([]);
  });

  it("registers and retrieves a factory", () => {
    const factory = makeFactory("alpha");
    const result = registerSecretSourceFactory(factory, { ownerPluginId: "alpha-plugin" });

    expect(result.ok).toBe(true);
    expect(lookupSecretSourceFactory("alpha")).toBe(factory);
    expect(listSecretSourceFactoryNames()).toEqual(["alpha"]);
  });

  it("returns undefined for an unregistered factory name", () => {
    expect(lookupSecretSourceFactory("missing")).toBeUndefined();
  });

  it("rejects duplicate factory registration", () => {
    registerSecretSourceFactory(makeFactory("alpha"), { ownerPluginId: "alpha-plugin" });
    const result = registerSecretSourceFactory(makeFactory("alpha"), {
      ownerPluginId: "other-plugin",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("duplicate");
      expect(result.existingOwner).toBe("alpha-plugin");
    }
  });

  it("lists factory names alphabetically", () => {
    registerSecretSourceFactory(makeFactory("zeta"));
    registerSecretSourceFactory(makeFactory("alpha"));
    registerSecretSourceFactory(makeFactory("mu"));

    expect(listSecretSourceFactoryNames()).toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("secret source alias bindings", () => {
  it("returns no-binding before any alias is bound", () => {
    expect(resolveSecretSourceAlias("anything")).toEqual({ ok: false, reason: "no-binding" });
  });

  it("binds and resolves an alias", () => {
    const source = makeSource("alpha", "primary");
    bindSecretSourceAlias({ alias: "primary", source, factoryName: "alpha" });

    const lookup = resolveSecretSourceAlias("primary");
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      expect(lookup.source).toBe(source);
    }
  });

  it("disposes the previous source when an alias is rebound", async () => {
    const disposed: string[] = [];
    const first: SecretSource = {
      ...makeSource("alpha", "primary"),
      dispose: () => {
        disposed.push("first");
      },
    };
    const second = makeSource("alpha", "primary", "second");

    bindSecretSourceAlias({ alias: "primary", source: first, factoryName: "alpha" });
    bindSecretSourceAlias({ alias: "primary", source: second, factoryName: "alpha" });
    await new Promise((r) => setImmediate(r));

    expect(disposed).toEqual(["first"]);
    const lookup = resolveSecretSourceAlias("primary");
    expect(lookup.ok && lookup.source === second).toBe(true);
  });

  it("removes a binding on dispose", () => {
    bindSecretSourceAlias({
      alias: "primary",
      source: makeSource("alpha", "primary"),
      factoryName: "alpha",
    });

    disposeSecretSourceAlias("primary");

    expect(resolveSecretSourceAlias("primary")).toEqual({ ok: false, reason: "no-binding" });
  });

  it("lists aliases alphabetically", () => {
    bindSecretSourceAlias({
      alias: "zeta",
      source: makeSource("alpha", "zeta"),
      factoryName: "alpha",
    });
    bindSecretSourceAlias({
      alias: "alpha",
      source: makeSource("alpha", "alpha"),
      factoryName: "alpha",
    });

    expect(listSecretSourceAliases()).toEqual(["alpha", "zeta"]);
  });
});

describe("secret source registry lifecycle", () => {
  it("clears factories and aliases together", () => {
    registerSecretSourceFactory(makeFactory("alpha"));
    bindSecretSourceAlias({
      alias: "primary",
      source: makeSource("alpha", "primary"),
      factoryName: "alpha",
    });

    clearSecretSourceRegistry();

    expect(listSecretSourceFactoryNames()).toEqual([]);
    expect(listSecretSourceAliases()).toEqual([]);
  });
});
