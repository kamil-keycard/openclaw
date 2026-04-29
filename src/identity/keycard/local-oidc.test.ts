import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLocalIdentityAvailable,
  LocalIdentityRequestError,
  LocalIdentityTokenCache,
  LocalIdentityUnavailableError,
  requestLocalIdentityToken,
} from "./local-oidc.js";

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

type FakeBinary = {
  binaryPath: string;
  /** Replace the JWT the fake binary will print on its next invocation. */
  setJwt(jwt: string): Promise<void>;
  /** Number of times the fake binary has been invoked. */
  callCount(): Promise<number>;
};

type FakeBinaryWithArgs = FakeBinary & {
  /** Arguments seen by the most recent invocation of the fake binary. */
  lastArgs(): Promise<string[]>;
  /** All argv lines captured (one per invocation). */
  argLog(): Promise<string[][]>;
};

async function withFakeBinary(
  initialJwt: string,
  run: (fake: FakeBinaryWithArgs) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-keycard-cli-"));
  const binaryPath = path.join(dir, "keycard-osx-oidc");
  const jwtPath = path.join(dir, "jwt");
  const counterPath = path.join(dir, "counter");
  const argsLogPath = path.join(dir, "args.log");
  await fs.writeFile(jwtPath, initialJwt, "utf8");
  await fs.writeFile(counterPath, "0", "utf8");
  await fs.writeFile(argsLogPath, "", "utf8");
  // The fake binary echoes the current JWT contents, bumps a call counter,
  // and records the argv on each invocation so tests can observe both the
  // number of CLI calls and the flags forwarded to the daemon.
  const tokenScript = [
    "#!/bin/sh",
    `count=$(cat "${counterPath}")`,
    `printf '%d' $((count + 1)) > "${counterPath}"`,
    `printf '%s\\n' "$*" >> "${argsLogPath}"`,
    `cat "${jwtPath}"`,
    "",
  ].join("\n");
  await fs.writeFile(binaryPath, tokenScript, { mode: 0o755 });
  const fake: FakeBinaryWithArgs = {
    binaryPath,
    async setJwt(jwt) {
      await fs.writeFile(jwtPath, jwt, "utf8");
    },
    async callCount() {
      const value = await fs.readFile(counterPath, "utf8");
      return Number.parseInt(value.trim(), 10) || 0;
    },
    async argLog() {
      const text = await fs.readFile(argsLogPath, "utf8");
      return text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.split(" ").filter((token) => token.length > 0));
    },
    async lastArgs() {
      const all = await fake.argLog();
      return all[all.length - 1] ?? [];
    },
  };
  try {
    await run(fake);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const isMacOs = process.platform === "darwin";

describe("isLocalIdentityAvailable", () => {
  it("reports not-darwin off macOS", async () => {
    if (isMacOs) {
      return;
    }
    const result = await isLocalIdentityAvailable();
    expect(result.available).toBe(false);
    expect(result.reason).toBe("not-darwin");
  });

  it("reports socket-missing when socket path does not exist", async () => {
    if (!isMacOs) {
      return;
    }
    const result = await isLocalIdentityAvailable({
      socketPath: path.join(os.tmpdir(), "definitely-not-a-keycard-socket.sock"),
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("socket-missing");
  });
});

describe("requestLocalIdentityToken", () => {
  it("rejects requests with an empty audience", async () => {
    await expect(requestLocalIdentityToken({ audience: "  " })).rejects.toBeInstanceOf(
      LocalIdentityRequestError,
    );
  });

  it("throws LocalIdentityUnavailableError off macOS", async () => {
    if (isMacOs) {
      return;
    }
    await expect(
      requestLocalIdentityToken({ audience: "https://example.test" }),
    ).rejects.toBeInstanceOf(LocalIdentityUnavailableError);
  });

  it("returns a parsed token when the CLI prints a valid JWT", async () => {
    if (!isMacOs) {
      return;
    }
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-123", aud: "https://example.test", exp });
    await withFakeBinary(jwt, async (fake) => {
      const fakeSocket = path.join(os.tmpdir(), "openclaw-fake-socket-present");
      await fs.writeFile(fakeSocket, "");
      try {
        const result = await requestLocalIdentityToken({
          audience: "https://example.test",
          binaryPath: fake.binaryPath,
          socketPath: fakeSocket,
        });
        expect(result.token).toBe(jwt);
        expect(result.expiresAt).toBe(exp);
        expect(result.claims.sub).toBe("user-123");
      } finally {
        await fs.rm(fakeSocket, { force: true });
      }
    });
  });

  it("rejects malformed JWT output", async () => {
    if (!isMacOs) {
      return;
    }
    await withFakeBinary("not-a-jwt", async (fake) => {
      const fakeSocket = path.join(os.tmpdir(), "openclaw-fake-socket-present-2");
      await fs.writeFile(fakeSocket, "");
      try {
        await expect(
          requestLocalIdentityToken({
            audience: "https://example.test",
            binaryPath: fake.binaryPath,
            socketPath: fakeSocket,
          }),
        ).rejects.toBeInstanceOf(LocalIdentityRequestError);
      } finally {
        await fs.rm(fakeSocket, { force: true });
      }
    });
  });

  it("forwards --agent <id> when agentId is set", async () => {
    if (!isMacOs) {
      return;
    }
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-agent", agent_id: "researcher", exp });
    await withFakeBinary(jwt, async (fake) => {
      const fakeSocket = path.join(os.tmpdir(), "openclaw-fake-socket-agent-flag");
      await fs.writeFile(fakeSocket, "");
      try {
        const result = await requestLocalIdentityToken({
          audience: "https://example.test",
          agentId: "researcher",
          binaryPath: fake.binaryPath,
          socketPath: fakeSocket,
        });
        expect(result.token).toBe(jwt);
        const args = await fake.lastArgs();
        expect(args).toEqual([
          "token",
          "--audience",
          "https://example.test",
          "--agent",
          "researcher",
        ]);
      } finally {
        await fs.rm(fakeSocket, { force: true });
      }
    });
  });

  it("omits --agent when agentId is missing or empty", async () => {
    if (!isMacOs) {
      return;
    }
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-no-agent", exp });
    await withFakeBinary(jwt, async (fake) => {
      const fakeSocket = path.join(os.tmpdir(), "openclaw-fake-socket-no-agent");
      await fs.writeFile(fakeSocket, "");
      try {
        await requestLocalIdentityToken({
          audience: "https://example.test",
          binaryPath: fake.binaryPath,
          socketPath: fakeSocket,
        });
        await requestLocalIdentityToken({
          audience: "https://example.test",
          agentId: "   ",
          binaryPath: fake.binaryPath,
          socketPath: fakeSocket,
        });
        const log = await fake.argLog();
        expect(log).toHaveLength(2);
        for (const args of log) {
          expect(args.includes("--agent")).toBe(false);
        }
      } finally {
        await fs.rm(fakeSocket, { force: true });
      }
    });
  });
});

describe("LocalIdentityTokenCache", () => {
  it("reuses tokens that are still well within their TTL", async () => {
    if (!isMacOs) {
      return;
    }
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-1", exp });
    const fakeSocket = path.join(os.tmpdir(), "openclaw-fake-socket-cache");
    await fs.writeFile(fakeSocket, "");
    try {
      await withFakeBinary(jwt, async (fake) => {
        const cache = new LocalIdentityTokenCache({
          binaryPath: fake.binaryPath,
          socketPath: fakeSocket,
        });
        const a = await cache.getToken("https://example.test");
        const b = await cache.getToken("https://example.test");
        expect(a.token).toBe(b.token);
        expect(await fake.callCount()).toBe(1);
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });

  it("caches independently per (audience, agentId) and forwards --agent", async () => {
    if (!isMacOs) {
      return;
    }
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-1", exp });
    const fakeSocket = path.join(os.tmpdir(), "openclaw-fake-socket-cache-agent");
    await fs.writeFile(fakeSocket, "");
    try {
      await withFakeBinary(jwt, async (fake) => {
        const cache = new LocalIdentityTokenCache({
          binaryPath: fake.binaryPath,
          socketPath: fakeSocket,
        });
        // Distinct entries for: gateway slot, "researcher", "coder".
        await cache.getToken("https://example.test");
        await cache.getToken("https://example.test", "researcher");
        await cache.getToken("https://example.test", "coder");
        // Repeated lookups hit the cache, no re-mint.
        await cache.getToken("https://example.test");
        await cache.getToken("https://example.test", "researcher");
        expect(await fake.callCount()).toBe(3);
        const log = await fake.argLog();
        expect(log).toHaveLength(3);
        const flagsByAgent = log.map((args) => {
          const idx = args.indexOf("--agent");
          return idx >= 0 ? args[idx + 1] : null;
        });
        expect(flagsByAgent).toEqual([null, "researcher", "coder"]);
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });

  it("coalesces concurrent getToken calls into a single CLI invocation", async () => {
    if (!isMacOs) {
      return;
    }
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-coalesce", exp });
    const fakeSocket = path.join(os.tmpdir(), "openclaw-fake-socket-cache-coalesce");
    await fs.writeFile(fakeSocket, "");
    try {
      await withFakeBinary(jwt, async (fake) => {
        const cache = new LocalIdentityTokenCache({
          binaryPath: fake.binaryPath,
          socketPath: fakeSocket,
        });
        const results = await Promise.all([
          cache.getToken("https://example.test"),
          cache.getToken("https://example.test"),
          cache.getToken("https://example.test"),
        ]);
        for (const r of results) {
          expect(r.token).toBe(jwt);
        }
        expect(await fake.callCount()).toBe(1);
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });

  it("invalidate(audience) drops every per-agent variant", async () => {
    if (!isMacOs) {
      return;
    }
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const jwt = encodeJwt({ sub: "user-1", exp });
    const fakeSocket = path.join(os.tmpdir(), "openclaw-fake-socket-cache-invalidate");
    await fs.writeFile(fakeSocket, "");
    try {
      await withFakeBinary(jwt, async (fake) => {
        const cache = new LocalIdentityTokenCache({
          binaryPath: fake.binaryPath,
          socketPath: fakeSocket,
        });
        await cache.getToken("https://example.test");
        await cache.getToken("https://example.test", "researcher");
        cache.invalidate("https://example.test");
        await cache.getToken("https://example.test");
        await cache.getToken("https://example.test", "researcher");
        expect(await fake.callCount()).toBe(4);
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });

  it("re-mints tokens that are within the refresh skew window", async () => {
    if (!isMacOs) {
      return;
    }
    const fakeSocket = path.join(os.tmpdir(), "openclaw-fake-socket-cache-skew");
    await fs.writeFile(fakeSocket, "");
    try {
      const initialExp = Math.floor(Date.now() / 1_000) + 60;
      const initialJwt = encodeJwt({ sub: "user-1", exp: initialExp });
      await withFakeBinary(initialJwt, async (fake) => {
        const cache = new LocalIdentityTokenCache({
          binaryPath: fake.binaryPath,
          socketPath: fakeSocket,
        });
        const first = await cache.getToken("https://example.test");
        expect(first.token).toBe(initialJwt);
        const refreshedExp = Math.floor(Date.now() / 1_000) + 3_600;
        const refreshedJwt = encodeJwt({ sub: "user-2", exp: refreshedExp });
        await fake.setJwt(refreshedJwt);
        const second = await cache.getToken("https://example.test");
        expect(second.token).toBe(refreshedJwt);
        expect(await fake.callCount()).toBe(2);
      });
    } finally {
      await fs.rm(fakeSocket, { force: true });
    }
  });
});
