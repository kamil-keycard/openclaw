import { describe, expect, it } from "vitest";
import {
  CLIENT_CREDENTIALS_GRANT_TYPE,
  discoverAuthorizationServer,
  JWT_BEARER_CLIENT_ASSERTION_TYPE,
  performTokenExchange,
  TokenExchangeError,
} from "./exchange.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("discoverAuthorizationServer", () => {
  it("builds the RFC 8414 discovery URL and returns token_endpoint", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return jsonResponse({
        issuer: "https://zone.keycard.cloud",
        token_endpoint: "https://zone.keycard.cloud/oauth/token",
      });
    };
    const metadata = await discoverAuthorizationServer(
      "https://zone.keycard.cloud",
      fetchImpl as typeof fetch,
    );
    expect(calls[0]).toBe("https://zone.keycard.cloud/.well-known/oauth-authorization-server");
    expect(metadata.token_endpoint).toBe("https://zone.keycard.cloud/oauth/token");
  });

  it("appends the issuer path when present", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return jsonResponse({
        issuer: "https://kc.example/tenants/acme",
        token_endpoint: "https://kc.example/tenants/acme/oauth/token",
      });
    };
    await discoverAuthorizationServer("https://kc.example/tenants/acme", fetchImpl as typeof fetch);
    expect(calls[0]).toBe("https://kc.example/.well-known/oauth-authorization-server/tenants/acme");
  });

  it("rejects when the issuer does not match", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        issuer: "https://other.keycard.cloud",
        token_endpoint: "https://other.keycard.cloud/oauth/token",
      });
    await expect(
      discoverAuthorizationServer("https://zone.keycard.cloud", fetchImpl as typeof fetch),
    ).rejects.toThrow(/issuer mismatch/);
  });

  it("rejects a non-200 response", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 });
    await expect(
      discoverAuthorizationServer("https://zone.keycard.cloud", fetchImpl as typeof fetch),
    ).rejects.toThrow(/discovery failed/);
  });
});

describe("performTokenExchange", () => {
  it("sends grant_type=client_credentials with jwt-bearer client assertion", async () => {
    let captured: { body: string; headers: Record<string, string> } | undefined;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      captured = {
        body: init.body as string,
        headers: init.headers as Record<string, string>,
      };
      return jsonResponse({
        access_token: "sk-openai-xyz",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "inference:write",
      });
    };
    const response = await performTokenExchange(
      {
        tokenEndpoint: "https://zone.keycard.cloud/oauth/token",
        assertion: { kind: "jwt-bearer", token: "eyAssertion" },
        resource: "https://api.openai.com",
        scopes: ["inference:write"],
        now: () => 2_000_000,
      },
      fetchImpl as typeof fetch,
    );

    const params = new URLSearchParams(captured!.body);
    expect(params.get("grant_type")).toBe(CLIENT_CREDENTIALS_GRANT_TYPE);
    expect(params.get("resource")).toBe("https://api.openai.com");
    expect(params.get("scope")).toBe("inference:write");
    expect(params.get("client_assertion")).toBe("eyAssertion");
    expect(params.get("client_assertion_type")).toBe(JWT_BEARER_CLIENT_ASSERTION_TYPE);
    expect(params.get("subject_token")).toBeNull();
    expect(params.get("subject_token_type")).toBeNull();
    expect(params.get("audience")).toBeNull();
    expect(params.get("requested_token_type")).toBeNull();

    expect(response.accessToken).toBe("sk-openai-xyz");
    expect(response.expiresIn).toBe(3600);
    expect(response.expiresAt).toBe(2_000_000 + 3600 * 1_000);
    expect(response.scope).toBe("inference:write");
  });

  it("uses HTTP Basic for client-credentials assertion", async () => {
    let captured: { body: string; headers: Record<string, string> } | undefined;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      captured = {
        body: init.body as string,
        headers: init.headers as Record<string, string>,
      };
      return jsonResponse({ access_token: "sk-xyz", token_type: "Bearer" });
    };
    await performTokenExchange(
      {
        tokenEndpoint: "https://zone.keycard.cloud/oauth/token",
        assertion: {
          kind: "client-basic",
          clientId: "svc_gateway",
          clientSecret: "s3cret",
        },
        resource: "https://api.example",
      },
      fetchImpl as typeof fetch,
    );
    expect(captured?.headers.authorization).toBe(
      `Basic ${Buffer.from("svc_gateway:s3cret").toString("base64")}`,
    );
    const params = new URLSearchParams(captured!.body);
    expect(params.get("grant_type")).toBe(CLIENT_CREDENTIALS_GRANT_TYPE);
    expect(params.has("client_assertion")).toBe(false);
    expect(params.get("subject_token")).toBeNull();
  });

  it("throws a TokenExchangeError for OAuth error responses", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "assertion expired" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    await expect(
      performTokenExchange(
        {
          tokenEndpoint: "https://zone.keycard.cloud/oauth/token",
          assertion: { kind: "jwt-bearer", token: "eyBad" },
          resource: "https://api.example",
        },
        fetchImpl as typeof fetch,
      ),
    ).rejects.toMatchObject({
      name: "TokenExchangeError",
      code: "invalid_grant",
      status: 401,
    });
  });

  it("rejects responses missing an access_token", async () => {
    const fetchImpl = async () => jsonResponse({ token_type: "Bearer" }, { status: 200 });
    await expect(
      performTokenExchange(
        {
          tokenEndpoint: "https://zone.keycard.cloud/oauth/token",
          assertion: { kind: "jwt-bearer", token: "ey" },
          resource: "https://api.example",
        },
        fetchImpl as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(TokenExchangeError);
  });
});
