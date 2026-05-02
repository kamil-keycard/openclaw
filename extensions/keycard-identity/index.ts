import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { KeycardPluginConfigSchema } from "./src/schema.js";
import { createKeycardSecretSourceFactory } from "./src/source.js";

export default definePluginEntry({
  id: "keycard-identity",
  name: "Keycard Identity",
  description:
    "Resolve SecretRefs via Keycard zones using workload-identity federation, client credentials, or private-key JWT.",
  configSchema: buildPluginConfigSchema(KeycardPluginConfigSchema),
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = parsePluginConfig(api.pluginConfig);
    const factory = createKeycardSecretSourceFactory({
      pluginConfig,
      logger: api.logger,
    });
    api.registerSecretSource(factory);
  },
});

function parsePluginConfig(raw: unknown) {
  if (raw == null) {
    return undefined;
  }
  const parsed = KeycardPluginConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}
