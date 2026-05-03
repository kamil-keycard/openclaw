import { describe, expect, it } from "vitest";
import {
  KeycardAliasConfigSchema,
  KeycardIdentityMethodSchema,
  KeycardPluginConfigSchema,
} from "./schema.js";

describe("KeycardPluginConfigSchema", () => {
  it("accepts a workload-identity macos-daemon config", () => {
    const parsed = KeycardPluginConfigSchema.parse({
      identity: {
        zoneId: "zone_abc123",
        method: {
          kind: "workload-identity",
          source: { type: "macos-daemon" },
        },
      },
    });
    expect(parsed.identity.zoneId).toBe("zone_abc123");
  });

  it("accepts a client-credentials config with a SecretRef", () => {
    const parsed = KeycardPluginConfigSchema.parse({
      identity: {
        zoneId: "zone_abc123",
        method: {
          kind: "client-credentials",
          clientId: "svc_gateway",
          clientSecret: {
            source: "env",
            provider: "default",
            id: "KEYCARD_GATEWAY_SECRET",
          },
        },
      },
    });
    expect(parsed.identity.method.kind).toBe("client-credentials");
  });

  it("accepts a private-key-jwt config with SecretRef for key", () => {
    const parsed = KeycardPluginConfigSchema.parse({
      identity: {
        zoneId: "zone_abc123",
        method: {
          kind: "private-key-jwt",
          clientId: "svc_gateway",
          keyId: "k1",
          privateKey: {
            source: "file",
            provider: "mounted",
            id: "/keys/gateway.pem",
          },
          signingAlg: "ES256",
        },
      },
    });
    expect(parsed.identity.method.kind).toBe("private-key-jwt");
  });

  it("rejects an unknown identity kind", () => {
    const result = KeycardPluginConfigSchema.safeParse({
      identity: {
        zoneId: "zone_abc123",
        method: { kind: "magic" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing clientSecret on client-credentials", () => {
    const result = KeycardIdentityMethodSchema.safeParse({
      kind: "client-credentials",
      clientId: "svc_gateway",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an explicit issuer override", () => {
    const parsed = KeycardPluginConfigSchema.parse({
      identity: {
        zoneId: "zone_abc123",
        issuer: "https://keycard.internal",
        method: {
          kind: "workload-identity",
          source: { type: "static-test", token: "test-jwt" },
        },
      },
    });
    expect(parsed.identity.issuer).toBe("https://keycard.internal");
  });
});

describe("KeycardAliasConfigSchema", () => {
  it("accepts an alias config with a resource catalog", () => {
    const parsed = KeycardAliasConfigSchema.parse({
      source: "plugin",
      plugin: "keycard-identity",
      resources: {
        "openai-api-key": { resource: "https://api.openai.com" },
        "anthropic-api-key": {
          resource: "https://api.anthropic.com",
          audience: "https://api.anthropic.com",
          scopes: ["inference:write"],
        },
      },
    });
    expect(Object.keys(parsed.resources).sort()).toEqual(["anthropic-api-key", "openai-api-key"]);
  });

  it("rejects an alias with a foreign plugin field", () => {
    const result = KeycardAliasConfigSchema.safeParse({
      source: "plugin",
      plugin: "not-keycard",
      resources: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects a resource entry missing a URL", () => {
    const result = KeycardAliasConfigSchema.safeParse({
      source: "plugin",
      plugin: "keycard-identity",
      resources: {
        bad: { resource: "not-a-url" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts per-resource cacheTtlSec", () => {
    const parsed = KeycardAliasConfigSchema.parse({
      source: "plugin",
      plugin: "keycard-identity",
      resources: {
        "openai-api-key": { resource: "https://api.openai.com", cacheTtlSec: 600 },
      },
    });
    expect(parsed.resources["openai-api-key"].cacheTtlSec).toBe(600);
  });

  it("accepts alias-level defaultCacheTtlSec", () => {
    const parsed = KeycardAliasConfigSchema.parse({
      source: "plugin",
      plugin: "keycard-identity",
      defaultCacheTtlSec: 300,
      resources: {
        "openai-api-key": { resource: "https://api.openai.com" },
      },
    });
    expect(parsed.defaultCacheTtlSec).toBe(300);
  });

  it("rejects non-positive cacheTtlSec", () => {
    const result = KeycardAliasConfigSchema.safeParse({
      source: "plugin",
      plugin: "keycard-identity",
      resources: {
        bad: { resource: "https://api.openai.com", cacheTtlSec: 0 },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects cacheTtlSec exceeding 86400", () => {
    const result = KeycardAliasConfigSchema.safeParse({
      source: "plugin",
      plugin: "keycard-identity",
      resources: {
        bad: { resource: "https://api.openai.com", cacheTtlSec: 86_401 },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive defaultCacheTtlSec", () => {
    const result = KeycardAliasConfigSchema.safeParse({
      source: "plugin",
      plugin: "keycard-identity",
      defaultCacheTtlSec: -1,
      resources: {},
    });
    expect(result.success).toBe(false);
  });

  it("allows an alias-level identity override", () => {
    const parsed = KeycardAliasConfigSchema.parse({
      source: "plugin",
      plugin: "keycard-identity",
      identity: {
        zoneId: "zone_override",
        method: {
          kind: "workload-identity",
          source: { type: "static-test", token: "override" },
        },
      },
      resources: {
        "openai-api-key": { resource: "https://api.openai.com" },
      },
    });
    expect(parsed.identity?.zoneId).toBe("zone_override");
  });
});
