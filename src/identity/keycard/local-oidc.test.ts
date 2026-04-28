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

async function withFakeBinary(
  initialJwt: string,
  run: (fake: FakeBinary) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-keycard-cli-"));
  const binaryPath = path.join(dir, "keycard-osx-oidc");
  const jwtPath = path.join(dir, "jwt");
  const counterPath = path.join(dir, "counter");
  await fs.writeFile(jwtPath, initialJwt, "utf8");
  await fs.writeFile(counterPath, "0", "utf8");
  // The fake binary echoes the current JWT contents and bumps a call counter
  // so the test can observe how many times the daemon CLI was invoked.
  const tokenScript = [
    "#!/bin/sh",
    `count=$(cat "${counterPath}")`,
    `printf '%d' $((count + 1)) > "${counterPath}"`,
    `cat "${jwtPath}"`,
    "",
  ].join("\n");
  await fs.writeFile(binaryPath, tokenScript, { mode: 0o755 });
  const fake: FakeBinary = {
    binaryPath,
    async setJwt(jwt) {
      await fs.writeFile(jwtPath, jwt, "utf8");
    },
    async callCount() {
      const value = await fs.readFile(counterPath, "utf8");
      return Number.parseInt(value.trim(), 10) || 0;
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
