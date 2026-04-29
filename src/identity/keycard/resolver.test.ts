import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resetDiscoveryCacheForTests } from "./exchange.js";
import { createKeycardResolver } from "./resolver.js";
import {
  DEFAULT_KEYCARD_PROVIDER_RESOURCES,
  effectiveProviderMappings,
  resolveKeycardResourceForProvider,
} from "./types.js";

const isMacOs = process.platform === "darwin";

function encodeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8")
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.signature`;
}

async function withFakeBinary(
  initialJwt: string,
  run: (binaryPath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-keycard-resolver-"));
  const binaryPath = path.join(dir, "keycard-osx-oidc");
  const tokenScript = `#!/bin/sh\nprintf '%s' '${initialJwt}'\n`;
  await fs.writeFile(binaryPath, tokenScript, { mode: 0o755 });
  try {
    await run(binaryPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeFetchResponder(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return ((input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
}

describe("effectiveProviderMappings", () => {
  it("layers built-in defaults under explicit entries", () => {
    const mappings = effectiveProviderMappings({
      providers: { anthropic: { resource: "urn:secret:custom-claude" } },
    });
    expect(mappings.anthropic?.resource).toBe("urn:secret:custom-claude");
    expect(mappings.openai?.resource).toBe(DEFAULT_KEYCARD_PROVIDER_RESOURCES.openai);
  });

  it("returns defaults when no providers are configured", () => {
    const mappings = effectiveProviderMappings(undefined);
    expect(mappings.anthropic?.resource).toBe(DEFAULT_KEYCARD_PROVIDER_RESOURCES.anthropic);
    expect(mappings.openai?.resource).toBe(DEFAULT_KEYCARD_PROVIDER_RESOURCES.openai);
  });
});

describe("resolveKeycardResourceForProvider", () => {
  it("returns undefined when identity config is missing", () => {
    expect(resolveKeycardResourceForProvider(undefined, "anthropic")).toBeUndefined();
  });

  it("falls back to defaults for known providers", () => {
    expect(resolveKeycardResourceForProvider({ zoneId: "z" }, "anthropic")).toBe(
      DEFAULT_KEYCARD_PROVIDER_RESOURCES.anthropic,
    );
  });

  it("returns explicit overrides", () => {
    expect(
      resolveKeycardResourceForProvider(
        { zoneId: "z", providers: { custom: { resource: "urn:secret:custom" } } },
        "custom",
      ),
    ).toBe("urn:secret:custom");
  });
});

describe("createKeycardResolver", () => {
  it("returns not-darwin when running off macOS", async () => {
    if (isMacOs) {
      return;
    }
    const resolver = createKeycardResolver({
      identity: { zoneId: "zone-1" },
      fetchImpl: makeFetchResponder(() => new Response("{}", { status: 500 })),
    });
    const outcome = await resolver.resolveProvider("anthropic");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("not-darwin");
    }
  });

  it("returns no-mapping for providers without a resource", async () => {
    if (!isMacOs) {
      return;
    }
    const fakeSocket = path.join(os.tmpdir(), "openclaw-resolver-no-mapping");
    await fs.writeFile(fakeSocket, "");
    try {
      const resolver = createKeycardResolver({
        identity: { zoneId: "zone-1", providers: {} },
        fetchImpl: makeFetchResponder(() => new Response("{}", { status: 500 })),
        localIdentityOptions: { socketPath: fakeSocket, binaryPath: "/usr/bin/false" },
      });
      const outcome = await resolver.resolveProvider("not-a-known-provider");
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe("no-mapping");
      }
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });

  it("performs discovery and exchange for a configured provider on macOS", async () => {
    if (!isMacOs) {
      return;
    }
    resetDiscoveryCacheForTests();
    const fakeSocket = path.join(os.tmpdir(), "openclaw-resolver-flow");
    await fs.writeFile(fakeSocket, "");
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-flow", aud: "https://zone-1.keycard.cloud", exp });
    let exchangeCalls = 0;
    const fetchImpl = makeFetchResponder((url) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://zone-1.keycard.cloud",
            token_endpoint: "https://zone-1.keycard.cloud/oauth/2/token",
          }),
          { status: 200 },
        );
      }
      if (url === "https://zone-1.keycard.cloud/oauth/2/token") {
        exchangeCalls += 1;
        return new Response(
          JSON.stringify({ access_token: `secret-${exchangeCalls}`, expires_in: 3_600 }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    try {
      await withFakeBinary(jwt, async (binaryPath) => {
        const resolver = createKeycardResolver({
          identity: { zoneId: "zone-1" },
          fetchImpl,
          localIdentityOptions: { binaryPath, socketPath: fakeSocket },
        });
        const first = await resolver.resolveProvider("anthropic");
        expect(first.ok).toBe(true);
        if (first.ok) {
          expect(first.accessToken).toBe("secret-1");
          expect(first.resource).toBe(DEFAULT_KEYCARD_PROVIDER_RESOURCES.anthropic);
        }
        const second = await resolver.resolveProvider("anthropic");
        expect(second.ok).toBe(true);
        if (second.ok) {
          expect(second.accessToken).toBe("secret-1");
        }
        expect(exchangeCalls).toBe(1);
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });

  it("reports discovery-failed when metadata fetch errors", async () => {
    if (!isMacOs) {
      return;
    }
    resetDiscoveryCacheForTests();
    const fakeSocket = path.join(os.tmpdir(), "openclaw-resolver-discovery-fail");
    await fs.writeFile(fakeSocket, "");
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-flow", exp });
    const fetchImpl = makeFetchResponder(() => new Response("nope", { status: 500 }));
    try {
      await withFakeBinary(jwt, async (binaryPath) => {
        const resolver = createKeycardResolver({
          identity: { zoneId: "zone-x" },
          fetchImpl,
          localIdentityOptions: { binaryPath, socketPath: fakeSocket },
        });
        const outcome = await resolver.resolveProvider("anthropic");
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.reason).toBe("discovery-failed");
        }
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });

  it("caches independently per (resource, agentId) and forwards --agent", async () => {
    if (!isMacOs) {
      return;
    }
    resetDiscoveryCacheForTests();
    const fakeSocket = path.join(os.tmpdir(), "openclaw-resolver-agent-cache");
    await fs.writeFile(fakeSocket, "");
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-flow", aud: "https://zone-a.keycard.cloud", exp });
    const exchangedAgents: (string | null)[] = [];
    const fetchImpl = makeFetchResponder((url, init) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://zone-a.keycard.cloud",
            token_endpoint: "https://zone-a.keycard.cloud/oauth/2/token",
          }),
          { status: 200 },
        );
      }
      if (url === "https://zone-a.keycard.cloud/oauth/2/token") {
        const params = new URLSearchParams(String(init.body ?? ""));
        const resource = params.get("resource") ?? "";
        const idx = exchangedAgents.length;
        exchangedAgents.push(idx === 0 ? null : idx === 1 ? "researcher" : "coder");
        return new Response(
          JSON.stringify({ access_token: `token-${resource}-${idx}`, expires_in: 3_600 }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    try {
      await withFakeBinary(jwt, async (binaryPath) => {
        const resolver = createKeycardResolver({
          identity: { zoneId: "zone-a" },
          fetchImpl,
          localIdentityOptions: { binaryPath, socketPath: fakeSocket },
        });
        const gateway = await resolver.resolveResource("urn:secret:claude-api");
        const researcher = await resolver.resolveResource("urn:secret:claude-api", {
          agentId: "researcher",
        });
        const coder = await resolver.resolveResource("urn:secret:claude-api", {
          agentId: "coder",
        });
        // Repeat lookups stay cached.
        const gatewayHit = await resolver.resolveResource("urn:secret:claude-api");
        const researcherHit = await resolver.resolveResource("urn:secret:claude-api", {
          agentId: "researcher",
        });
        expect(gateway.ok && researcher.ok && coder.ok).toBe(true);
        if (gateway.ok && researcher.ok && coder.ok) {
          expect(gateway.accessToken).not.toBe(researcher.accessToken);
          expect(researcher.accessToken).not.toBe(coder.accessToken);
        }
        if (gatewayHit.ok && researcherHit.ok && gateway.ok && researcher.ok) {
          expect(gatewayHit.accessToken).toBe(gateway.accessToken);
          expect(researcherHit.accessToken).toBe(researcher.accessToken);
        }
        // Three distinct exchange calls (one per agent slot).
        expect(exchangedAgents.length).toBe(3);
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });

  it("evicts oldest cache entry once exchangeCacheMaxEntries is exceeded", async () => {
    if (!isMacOs) {
      return;
    }
    resetDiscoveryCacheForTests();
    const fakeSocket = path.join(os.tmpdir(), "openclaw-resolver-evict");
    await fs.writeFile(fakeSocket, "");
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-flow", exp });
    let exchangeCalls = 0;
    const fetchImpl = makeFetchResponder((url) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://zone-evict.keycard.cloud",
            token_endpoint: "https://zone-evict.keycard.cloud/oauth/2/token",
          }),
          { status: 200 },
        );
      }
      if (url === "https://zone-evict.keycard.cloud/oauth/2/token") {
        exchangeCalls += 1;
        return new Response(
          JSON.stringify({ access_token: `token-${exchangeCalls}`, expires_in: 3_600 }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    try {
      await withFakeBinary(jwt, async (binaryPath) => {
        const resolver = createKeycardResolver({
          identity: { zoneId: "zone-evict" },
          fetchImpl,
          localIdentityOptions: { binaryPath, socketPath: fakeSocket },
          exchangeCacheMaxEntries: 2,
        });
        // Three distinct agents fill and evict the LRU window.
        const a = await resolver.resolveResource("urn:secret:r1", { agentId: "a" });
        const b = await resolver.resolveResource("urn:secret:r1", { agentId: "b" });
        const c = await resolver.resolveResource("urn:secret:r1", { agentId: "c" });
        expect(a.ok && b.ok && c.ok).toBe(true);
        expect(exchangeCalls).toBe(3);
        // Agent "a" should have been evicted; re-resolving forces a fresh exchange.
        const aAgain = await resolver.resolveResource("urn:secret:r1", { agentId: "a" });
        if (a.ok && aAgain.ok) {
          expect(aAgain.accessToken).not.toBe(a.accessToken);
        }
        expect(exchangeCalls).toBe(4);
        // Agent "c" stays cached (most-recent).
        const cAgain = await resolver.resolveResource("urn:secret:r1", { agentId: "c" });
        if (c.ok && cAgain.ok) {
          expect(cAgain.accessToken).toBe(c.accessToken);
        }
        expect(exchangeCalls).toBe(4);
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });

  it("prefetches every configured resource", async () => {
    if (!isMacOs) {
      return;
    }
    resetDiscoveryCacheForTests();
    const fakeSocket = path.join(os.tmpdir(), "openclaw-resolver-prefetch");
    await fs.writeFile(fakeSocket, "");
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-flow", exp });
    const seen = new Set<string>();
    const fetchImpl = makeFetchResponder((url, init) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://zone-pre.keycard.cloud",
            token_endpoint: "https://zone-pre.keycard.cloud/oauth/2/token",
          }),
          { status: 200 },
        );
      }
      if (url === "https://zone-pre.keycard.cloud/oauth/2/token") {
        const params = new URLSearchParams(String(init.body ?? ""));
        const resource = params.get("resource") ?? "";
        seen.add(resource);
        return new Response(
          JSON.stringify({ access_token: `token-${resource}`, expires_in: 3_600 }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    try {
      await withFakeBinary(jwt, async (binaryPath) => {
        const resolver = createKeycardResolver({
          identity: { zoneId: "zone-pre" },
          fetchImpl,
          localIdentityOptions: { binaryPath, socketPath: fakeSocket },
        });
        const outcomes = await resolver.prefetch();
        expect(outcomes.length).toBeGreaterThanOrEqual(2);
        expect(seen.has(DEFAULT_KEYCARD_PROVIDER_RESOURCES.anthropic)).toBe(true);
        expect(seen.has(DEFAULT_KEYCARD_PROVIDER_RESOURCES.openai)).toBe(true);
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });
});
