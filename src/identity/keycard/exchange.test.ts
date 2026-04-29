import { describe, expect, it, vi } from "vitest";
import {
  discoverAuthorizationServerMetadata,
  exchangeForResource,
  issuerForZone,
  JWT_BEARER_CLIENT_ASSERTION_TYPE,
  KeycardDiscoveryError,
  KeycardTokenExchangeError,
  resetDiscoveryCacheForTests,
} from "./exchange.js";

function makeFetchResponder(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return ((input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
}

describe("issuerForZone", () => {
  it("uses the default keycard.cloud domain", () => {
    expect(issuerForZone("zone-abc")).toBe("https://zone-abc.keycard.cloud");
  });

  it("rejects empty zone ids", () => {
    expect(() => issuerForZone("")).toThrow(KeycardDiscoveryError);
  });
});

describe("discoverAuthorizationServerMetadata", () => {
  it("fetches and parses RFC 8414 metadata", async () => {
    resetDiscoveryCacheForTests();
    const fetchImpl = makeFetchResponder((url) => {
      expect(url).toBe("https://zone-1.keycard.cloud/.well-known/oauth-authorization-server");
      return new Response(
        JSON.stringify({
          issuer: "https://zone-1.keycard.cloud",
          token_endpoint: "https://zone-1.keycard.cloud/oauth/2/token",
          jwks_uri: "https://zone-1.keycard.cloud/oauth/2/jwks.json",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const metadata = await discoverAuthorizationServerMetadata("zone-1", { fetchImpl });
    expect(metadata.issuer).toBe("https://zone-1.keycard.cloud");
    expect(metadata.token_endpoint).toBe("https://zone-1.keycard.cloud/oauth/2/token");
    expect(metadata.jwks_uri).toBe("https://zone-1.keycard.cloud/oauth/2/jwks.json");
  });

  it("caches successful discovery responses per issuer", async () => {
    resetDiscoveryCacheForTests();
    const fetchImpl = vi.fn(
      makeFetchResponder(
        () =>
          new Response(
            JSON.stringify({
              issuer: "https://zone-2.keycard.cloud",
              token_endpoint: "https://zone-2.keycard.cloud/oauth/2/token",
            }),
            { status: 200 },
          ),
      ),
    );
    await discoverAuthorizationServerMetadata("zone-2", { fetchImpl });
    await discoverAuthorizationServerMetadata("zone-2", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-200 discovery responses", async () => {
    resetDiscoveryCacheForTests();
    const fetchImpl = makeFetchResponder(() => new Response("nope", { status: 404 }));
    await expect(
      discoverAuthorizationServerMetadata("zone-3", { fetchImpl }),
    ).rejects.toBeInstanceOf(KeycardDiscoveryError);
  });

  it("rejects discovery payloads missing token_endpoint", async () => {
    resetDiscoveryCacheForTests();
    const fetchImpl = makeFetchResponder(
      () =>
        new Response(JSON.stringify({ issuer: "https://zone-4.keycard.cloud" }), { status: 200 }),
    );
    await expect(
      discoverAuthorizationServerMetadata("zone-4", { fetchImpl }),
    ).rejects.toBeInstanceOf(KeycardDiscoveryError);
  });

  it("accepts a fully-qualified issuer URL in place of a zone id", async () => {
    resetDiscoveryCacheForTests();
    const fetchImpl = makeFetchResponder((url) => {
      expect(url).toBe("https://custom-issuer.example/.well-known/oauth-authorization-server");
      return new Response(
        JSON.stringify({
          issuer: "https://custom-issuer.example",
          token_endpoint: "https://custom-issuer.example/oauth/2/token",
        }),
        { status: 200 },
      );
    });
    const metadata = await discoverAuthorizationServerMetadata("https://custom-issuer.example/", {
      fetchImpl,
    });
    expect(metadata.token_endpoint).toBe("https://custom-issuer.example/oauth/2/token");
  });
});

describe("exchangeForResource", () => {
  it("posts a client_credentials grant with a JWT-bearer assertion", async () => {
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = makeFetchResponder((url, init) => {
      expect(url).toBe("https://zone-1.keycard.cloud/oauth/2/token");
      expect(init.method).toBe("POST");
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = String(init.body ?? "");
      return new Response(
        JSON.stringify({ access_token: "secret-key", token_type: "Bearer", expires_in: 3_600 }),
        { status: 200 },
      );
    });
    const response = await exchangeForResource(
      {
        tokenEndpoint: "https://zone-1.keycard.cloud/oauth/2/token",
        clientAssertion: "header.payload.sig",
        resource: "urn:secret:claude-api",
      },
      { fetchImpl },
    );
    expect(response.accessToken).toBe("secret-key");
    expect(response.tokenType).toBe("Bearer");
    expect(response.expiresIn).toBe(3_600);
    expect(capturedHeaders["content-type"] ?? capturedHeaders["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_assertion_type")).toBe(JWT_BEARER_CLIENT_ASSERTION_TYPE);
    expect(params.get("client_assertion")).toBe("header.payload.sig");
    expect(params.get("resource")).toBe("urn:secret:claude-api");
  });

  it("surfaces OAuth error envelopes on failure", async () => {
    const fetchImpl = makeFetchResponder(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_client",
            error_description: "client_assertion was rejected",
          }),
          { status: 401 },
        ),
    );
    await expect(
      exchangeForResource(
        {
          tokenEndpoint: "https://zone-1.keycard.cloud/oauth/2/token",
          clientAssertion: "header.payload.sig",
          resource: "urn:secret:claude-api",
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "KeycardTokenExchangeError",
      status: 401,
      oauthError: "invalid_client",
      oauthErrorDescription: "client_assertion was rejected",
    });
  });

  it("rejects responses missing access_token", async () => {
    const fetchImpl = makeFetchResponder(
      () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
    );
    await expect(
      exchangeForResource(
        {
          tokenEndpoint: "https://zone-1.keycard.cloud/oauth/2/token",
          clientAssertion: "header.payload.sig",
          resource: "urn:secret:claude-api",
        },
        { fetchImpl },
      ),
    ).rejects.toBeInstanceOf(KeycardTokenExchangeError);
  });

  it("validates required inputs", async () => {
    await expect(
      exchangeForResource({ tokenEndpoint: "", clientAssertion: "x", resource: "y" }),
    ).rejects.toBeInstanceOf(KeycardTokenExchangeError);
    await expect(
      exchangeForResource({ tokenEndpoint: "x", clientAssertion: "", resource: "y" }),
    ).rejects.toBeInstanceOf(KeycardTokenExchangeError);
    await expect(
      exchangeForResource({ tokenEndpoint: "x", clientAssertion: "y", resource: "  " }),
    ).rejects.toBeInstanceOf(KeycardTokenExchangeError);
  });
});
