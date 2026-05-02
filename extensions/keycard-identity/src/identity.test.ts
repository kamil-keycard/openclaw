import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireClientAssertion, signPrivateKeyJwt, type MacosDaemonClient } from "./identity.js";

describe("acquireClientAssertion — workload-identity", () => {
  it("reads a token from the macOS daemon", async () => {
    const client: MacosDaemonClient = async (request) => {
      expect(request.socketPath).toBe("/custom.sock");
      expect(request.audience).toBe("https://issuer.example/token");
      return { token: "daemon-jwt-123", expiresAt: 5_000 };
    };

    const assertion = await acquireClientAssertion(
      {
        kind: "workload-identity",
        source: { type: "macos-daemon", socketPath: "/custom.sock" },
      },
      {
        tokenEndpoint: "https://issuer.example/token",
        issuer: "https://issuer.example",
        clientIdForAssertion: "gateway",
      },
      { macosDaemonClient: client },
    );
    expect(assertion.kind).toBe("jwt-bearer");
    if (assertion.kind === "jwt-bearer") {
      expect(assertion.token).toBe("daemon-jwt-123");
      expect(assertion.expiresAt).toBe(5_000);
    }
  });

  it("reads a token from a token-file", async () => {
    const assertion = await acquireClientAssertion(
      {
        kind: "workload-identity",
        source: { type: "token-file", path: "/ignored.json" },
      },
      {
        tokenEndpoint: "https://issuer.example/token",
        issuer: "https://issuer.example",
        clientIdForAssertion: "gateway",
      },
      { readTokenFile: async () => "  eyJfile  \n" },
    );
    expect(assertion.kind).toBe("jwt-bearer");
    if (assertion.kind === "jwt-bearer") {
      expect(assertion.token).toBe("eyJfile");
    }
  });

  it("fails when the token-file is empty", async () => {
    await expect(
      acquireClientAssertion(
        {
          kind: "workload-identity",
          source: { type: "token-file", path: "/empty" },
        },
        {
          tokenEndpoint: "https://issuer.example/token",
          issuer: "https://issuer.example",
          clientIdForAssertion: "gateway",
        },
        { readTokenFile: async () => "" },
      ),
    ).rejects.toThrow(/token-file is empty/);
  });

  it("returns static-test tokens verbatim", async () => {
    const assertion = await acquireClientAssertion(
      {
        kind: "workload-identity",
        source: { type: "static-test", token: "test-jwt", expiresAt: 99 },
      },
      {
        tokenEndpoint: "https://issuer.example/token",
        issuer: "https://issuer.example",
        clientIdForAssertion: "gateway",
      },
    );
    expect(assertion.kind).toBe("jwt-bearer");
    if (assertion.kind === "jwt-bearer") {
      expect(assertion.token).toBe("test-jwt");
      expect(assertion.expiresAt).toBe(99);
    }
  });

  it("reports SPIFFE as not yet implemented", async () => {
    await expect(
      acquireClientAssertion(
        {
          kind: "workload-identity",
          source: { type: "spiffe" },
        },
        {
          tokenEndpoint: "https://issuer.example/token",
          issuer: "https://issuer.example",
          clientIdForAssertion: "gateway",
        },
      ),
    ).rejects.toThrow(/SPIFFE/);
  });
});

describe("acquireClientAssertion — client-credentials", () => {
  it("returns HTTP Basic credentials using the injected resolver", async () => {
    const assertion = await acquireClientAssertion(
      {
        kind: "client-credentials",
        clientId: "svc_gateway",
        clientSecret: { source: "env", provider: "default", id: "KC_SECRET" },
      },
      {
        tokenEndpoint: "https://issuer.example/token",
        issuer: "https://issuer.example",
        clientIdForAssertion: "svc_gateway",
      },
      { resolveSecretRef: async () => "plaintext-secret" },
    );
    expect(assertion).toEqual({
      kind: "client-basic",
      clientId: "svc_gateway",
      clientSecret: "plaintext-secret",
    });
  });

  it("fails when no resolver is injected", async () => {
    await expect(
      acquireClientAssertion(
        {
          kind: "client-credentials",
          clientId: "svc_gateway",
          clientSecret: { source: "env", provider: "default", id: "KC_SECRET" },
        },
        {
          tokenEndpoint: "https://issuer.example/token",
          issuer: "https://issuer.example",
          clientIdForAssertion: "svc_gateway",
        },
      ),
    ).rejects.toThrow(/SecretRef resolution not available/);
  });
});

describe("signPrivateKeyJwt", () => {
  afterEach(() => {
    // No shared state to clean; placeholder hook kept for symmetry.
  });

  it("signs a JWT with RS256 and returns an absolute expiry", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const now = () => 1_700_000_000_000;

    const signed = await signPrivateKeyJwt({
      pem,
      keyId: "k1",
      clientId: "svc_gateway",
      audience: "https://issuer.example/token",
      signingAlg: "RS256",
      lifetimeSec: 120,
      now,
    });

    expect(signed.token.split(".")).toHaveLength(3);
    expect(signed.expiresAt).toBe(1_700_000_120 * 1_000);

    const [headerB64, payloadB64] = signed.token.split(".");
    const header = JSON.parse(
      Buffer.from(headerB64!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    const payload = JSON.parse(
      Buffer.from(payloadB64!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );

    expect(header).toMatchObject({ alg: "RS256", typ: "JWT", kid: "k1" });
    expect(payload).toMatchObject({
      iss: "svc_gateway",
      sub: "svc_gateway",
      aud: "https://issuer.example/token",
    });
    expect(typeof payload.jti).toBe("string");
  });

  it("signs a JWT with ES256 using the P-256 curve", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const signed = await signPrivateKeyJwt({
      pem,
      keyId: "k2",
      clientId: "svc_gateway",
      audience: "https://issuer.example/token",
      signingAlg: "ES256",
    });

    // ES256 p1363 signatures are 64 raw bytes → ~86 base64url chars.
    const parts = signed.token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[2]!.length).toBeGreaterThanOrEqual(80);
  });
});

describe("token-file integration", () => {
  it("reads an actual file from disk via the default reader", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keycard-id-"));
    try {
      const filepath = path.join(dir, "token");
      await writeFile(filepath, "eyFromDisk\n", { mode: 0o600 });
      const assertion = await acquireClientAssertion(
        {
          kind: "workload-identity",
          source: { type: "token-file", path: filepath },
        },
        {
          tokenEndpoint: "https://issuer.example/token",
          issuer: "https://issuer.example",
          clientIdForAssertion: "gateway",
        },
      );
      expect(assertion.kind).toBe("jwt-bearer");
      if (assertion.kind === "jwt-bearer") {
        expect(assertion.token).toBe("eyFromDisk");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
