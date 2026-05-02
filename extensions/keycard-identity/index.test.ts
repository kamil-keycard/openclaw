import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

describe("keycard-identity plugin entry", () => {
  it("registers a SecretSource factory named keycard-identity", () => {
    const registerSecretSource = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "keycard-identity",
        name: "Keycard Identity",
        source: "test",
        registerSecretSource,
        pluginConfig: {
          identity: {
            zoneId: "zone_abc",
            method: {
              kind: "workload-identity",
              source: { type: "static-test", token: "t" },
            },
          },
        },
      }),
    );
    expect(registerSecretSource).toHaveBeenCalledTimes(1);
    const factory = registerSecretSource.mock.calls[0]?.[0];
    expect(factory?.name).toBe("keycard-identity");
    expect(typeof factory?.configSchema.parse).toBe("function");
    expect(typeof factory?.create).toBe("function");
  });

  it("does nothing in non-full registration mode", () => {
    const registerSecretSource = vi.fn();
    plugin.register(
      createTestPluginApi({
        registrationMode: "metadata",
        registerSecretSource,
      }),
    );
    expect(registerSecretSource).not.toHaveBeenCalled();
  });

  it("tolerates missing pluginConfig (diagnose will surface it later)", () => {
    const registerSecretSource = vi.fn();
    plugin.register(
      createTestPluginApi({
        registerSecretSource,
        pluginConfig: undefined,
      }),
    );
    expect(registerSecretSource).toHaveBeenCalledTimes(1);
  });

  it("exposes a plugin-config schema validator on the plugin entry", () => {
    const parsed = plugin.configSchema.safeParse({
      identity: {
        zoneId: "zone_abc",
        method: {
          kind: "client-credentials",
          clientId: "svc",
          clientSecret: { source: "env", provider: "default", id: "KC_SECRET" },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects plugin configs that do not satisfy the schema", () => {
    const parsed = plugin.configSchema.safeParse({ identity: { zoneId: "zone_abc" } });
    expect(parsed.success).toBe(false);
  });
});
