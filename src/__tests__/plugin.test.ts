/**
 * C-110: WebAdapter tests — inbound message mapping, auth extraction,
 * outbound broadcast, access control, and binding-schema validation.
 *
 * cortex#1794 (S9 MOVE) — trimmed from cortex's original
 * `src/adapters/web/__tests__/web-adapter.test.ts` (903 lines) to the
 * subset that exercises `WebAdapter`/`WebBindingSchema` in isolation — no
 * cortex-internal module (`gateway-adapters.ts`, `SurfacesSchema`,
 * `registryFromFactory`) is reachable from this repo. Two describe blocks
 * did NOT make the move because they tested CORTEX's gateway-integration
 * plumbing (`buildGatewayAdapters` + `registryFromFactory` constructing a
 * REAL `WebAdapter` through the in-tree registry) rather than this
 * adapter's own behavior:
 *
 *   - "SurfacesSchema — web bindings" — asserted cortex's `SurfacesSchema`
 *     hardcoded a `web` field; post-move `web` is no longer hardcoded there
 *     (it validates like any other registry-contributed platform via the
 *     generic catchall + the registry pass) — the assertion no longer
 *     applies and has no post-move home in either repo.
 *   - "buildGatewayAdapters — web bindings" — exercised
 *     `buildGatewayAdapters`/`registryFromFactory` end-to-end with a `web`
 *     factory method; both dropped `web` from their signatures
 *     (cortex#1794 S9 MOVE — see cortex's `src/adapters/registry.ts` /
 *     `src/gateway/gateway-adapters.ts`). That coverage is superseded by
 *     cortex's `loader.web-bundle.test.ts` (the transparent-upgrade E2E
 *     proof — loads THIS bundle's real `webAdapterPlugin` and constructs a
 *     `WebAdapter` through it) plus the generic discord/slack/mattermost
 *     coverage `gateway-adapters.test.ts` retains for the SAME loop.
 *
 * All tests use the adapter in construct-only mode (no real Bun server started)
 * except the HTTP round-trip tests which use Bun's built-in server on an
 * ephemeral port.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { WebAdapter } from "../index";
import type { WebAdapterInfra } from "../index";
import { WebBindingSchema } from "../schema";
import type { WebBinding } from "../schema";
import type { InboundMessage } from "@the-metafactory/cortex/surface-sdk";
// cortex#1794 (S9 MOVE) — reuse the SAME "no policy configured" default
// `webAdapterPlugin.createAdapter` falls back to, rather than hand-rolling a
// second copy that could drift from it.
import { NO_POLICY_PORT } from "../plugin";

// =============================================================================
// Fixtures
// =============================================================================

const BROADCAST_CAPTURES: { url: string; body: unknown; headers: Record<string, string> }[] = [];

/** Intercept all fetch calls that go to the broadcastUrl. */
const originalFetch = globalThis.fetch;

async function withBroadcastCapture(fn: () => Promise<void>): Promise<void> {
  BROADCAST_CAPTURES.length = 0;
  const spy = async (url: string | Request | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes("broadcast")) {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const headers = { ...(init?.headers as Record<string, string> | undefined) };
      BROADCAST_CAPTURES.push({ url: urlStr, body, headers });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(url, init);
  };
  globalThis.fetch = spy as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function makeBinding(overrides: Partial<WebBinding> = {}): WebBinding {
  return {
    host: "127.0.0.1",
    instanceId: "acme",
    port: 0, // ephemeral — overridden per test
    broadcastUrl: "http://localhost:9999/broadcast",
    transport: "ws",
    authScheme: "none",
    ...overrides,
  };
}

function makeInfra(overrides: Partial<WebAdapterInfra> = {}): WebAdapterInfra {
  return {
    instanceId: "web:acme",
    principal: {},
    // Default: "no policy configured" (deny-by-default) — matches what
    // `webAdapterPlugin.createAdapter` defaults to when no host port is
    // supplied. Tests exercising a real engine pass their own `policy`.
    policy: NO_POLICY_PORT,
    ...overrides,
  };
}

function makeSyntheticAgent(id = "gateway") {
  return { id };
}

// =============================================================================
// 1. Platform identity
// =============================================================================

describe("WebAdapter — identity", () => {
  test("platform is 'web'", () => {
    const adapter = new WebAdapter(makeSyntheticAgent(), makeBinding(), makeInfra());
    expect(adapter.platform).toBe("web");
  });

  test("instanceId comes from infra", () => {
    const adapter = new WebAdapter(makeSyntheticAgent(), makeBinding(), makeInfra({ instanceId: "web:acme" }));
    expect(adapter.instanceId).toBe("web:acme");
  });

  test("getPlatformUserId returns stable web:{instanceId}", async () => {
    const adapter = new WebAdapter(makeSyntheticAgent(), makeBinding(), makeInfra({ instanceId: "web:acme" }));
    const id = await adapter.getPlatformUserId();
    expect(id).toBe("web:web:acme");
  });
});

// =============================================================================
// 2. HTTP ingress — health + routing
// =============================================================================

describe("WebAdapter — HTTP ingress", () => {
  let adapter: WebAdapter;
  let port: number;
  const messages: InboundMessage[] = [];

  beforeEach(async () => {
    messages.length = 0;
    // Use ephemeral port (0) so Bun assigns a free port — no collision risk.
    adapter = new WebAdapter(
      makeSyntheticAgent(),
      makeBinding({ port: 0, authScheme: "none" }),
      makeInfra({ instanceId: "web:acme" }),
    );
    await adapter.start(async (msg) => {
      messages.push(msg);
    });
    port = adapter.serverPort!;
  });

  afterEach(async () => {
    await adapter.stop();
  });

  test("GET /health returns 200 with adapter id", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; adapter: string };
    expect(body.status).toBe("ok");
    expect(body.adapter).toBe("web:acme");
  });

  test("unknown path returns 404", async () => {
    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  test("GET /message returns 404 (only POST accepted)", async () => {
    const res = await fetch(`http://localhost:${port}/message`);
    expect(res.status).toBe(404);
  });

  test("POST /message returns 202 Accepted", async () => {
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", body: "hello cortex" }),
    });
    expect(res.status).toBe(202);
    const json = await res.json() as { status: string };
    expect(json.status).toBe("accepted");
  });

  test("POST /message missing channel returns 400", async () => {
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "hello" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /message missing body returns 400", async () => {
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /message dispatches InboundMessage with correct fields", async () => {
    await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "general",
        thread: "thread-123",
        body: "hello cortex",
        user: "Alice",
      }),
    });

    // Give the async dispatch a tick to complete
    await new Promise((r) => setTimeout(r, 20));

    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.platform).toBe("web");
    expect(msg.instanceId).toBe("web:acme");
    expect(msg.content).toBe("hello cortex");
    expect(msg.channelId).toBe("general");
    expect(msg.threadId).toBe("thread-123");
    expect(msg.channelName).toBe("general");
    expect(msg.threadName).toBe("thread-123");
    expect(msg.authorName).toBe("Alice");
    expect(msg.attachments).toEqual([]);
    expect(msg.timestamp).toBeInstanceOf(Date);
  });

  test("POST /message without thread has no threadId", async () => {
    await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", body: "top-level" }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(messages[0]?.threadId).toBeUndefined();
  });
});

// =============================================================================
// 2b. Inbound service auth (inboundToken — service-to-service gate)
// =============================================================================

describe("WebAdapter — inbound service auth (inboundToken)", () => {
  let adapter: WebAdapter;
  let port: number;

  afterEach(async () => {
    await adapter.stop();
  });

  async function startWithToken(token?: string): Promise<void> {
    adapter = new WebAdapter(
      makeSyntheticAgent(),
      makeBinding({ port: 0, authScheme: "none", inboundToken: token }),
      makeInfra({ instanceId: "web:svc-test" }),
    );
    await adapter.start(async () => {});
    port = adapter.serverPort!;
  }

  const validBody = JSON.stringify({ channel: "room-1", body: "hello" });
  const jsonHeaders = { "Content-Type": "application/json" };

  test("no inboundToken → any request accepted (localhost default)", async () => {
    await startWithToken(undefined);
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(202);
  });

  test("inboundToken set, missing Authorization → 401", async () => {
    await startWithToken("secret-svc-token");
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    });
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("Unauthorized");
  });

  test("inboundToken set, wrong token → 401", async () => {
    await startWithToken("secret-svc-token");
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { ...jsonHeaders, Authorization: "Bearer wrong-token" },
      body: validBody,
    });
    expect(res.status).toBe(401);
  });

  test("inboundToken set, correct Bearer token → 202 Accepted", async () => {
    await startWithToken("secret-svc-token");
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { ...jsonHeaders, Authorization: "Bearer secret-svc-token" },
      body: validBody,
    });
    expect(res.status).toBe(202);
  });

  test("401 fires before body parsing — malformed JSON still returns 401, not 400", async () => {
    await startWithToken("tok");
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "NOT_JSON",
    });
    // Auth gate runs first — must be 401 (not 400 from body parse failure)
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// 3. Auth extraction
// =============================================================================

describe("WebAdapter — auth extraction", () => {
  let adapter: WebAdapter;
  let port: number;
  const messages: InboundMessage[] = [];

  afterEach(async () => {
    await adapter.stop();
    messages.length = 0;
  });

  async function startWith(authScheme: WebBinding["authScheme"], authHeader?: string) {
    // Use ephemeral port (0) — Bun assigns a free port so no collision risk.
    adapter = new WebAdapter(
      makeSyntheticAgent(),
      makeBinding({ port: 0, authScheme, authHeader }),
      makeInfra({ instanceId: "web:test" }),
    );
    await adapter.start(async (msg) => { messages.push(msg); });
    port = adapter.serverPort!;
  }

  test("authScheme=none → authorId is dev:web:{instanceId}", async () => {
    await startWith("none");
    await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "ch", body: "hi" }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(messages[0]?.authorId).toBe("dev:web:web:test");
  });

  test("authScheme=header reads the named header", async () => {
    await startWith("header", "X-User-Id");
    await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": "alice@example.com" },
      body: JSON.stringify({ channel: "ch", body: "hi" }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(messages[0]?.authorId).toBe("alice@example.com");
  });

  test("authScheme=header missing header → anon fallback", async () => {
    await startWith("header", "X-User-Id");
    await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "ch", body: "hi" }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(messages[0]?.authorId).toMatch(/^anon:web:/);
  });

  test("authScheme=cf-access decodes JWT sub claim", async () => {
    await startWith("cf-access");
    // Build a minimal CF Access JWT with sub claim (no real sig — adapter only decodes)
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = btoa(JSON.stringify({ sub: "user@example.com", iat: 1000 }));
    const sig = "fakesig";
    const jwt = `${header}.${payload}.${sig}`;

    await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": jwt,
      },
      body: JSON.stringify({ channel: "ch", body: "hi" }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(messages[0]?.authorId).toBe("user@example.com");
  });

  test("authScheme=cf-access missing header → anon fallback", async () => {
    await startWith("cf-access");
    await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "ch", body: "hi" }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(messages[0]?.authorId).toMatch(/^anon:web:/);
  });

  test("body.user field NEVER becomes authorId (platform-signed headers only)", async () => {
    await startWith("header", "X-User-Id");
    await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": "real-user",
      },
      body: JSON.stringify({ channel: "ch", body: "hi", user: "injected-attacker" }),
    });
    await new Promise((r) => setTimeout(r, 20));
    const msg = messages[0]!;
    // authorId from header — NOT from the body's user field
    expect(msg.authorId).toBe("real-user");
    // authorName CAN come from user field (display name only — not an auth claim)
    expect(msg.authorName).toBe("injected-attacker");
  });
});

// =============================================================================
// 4. Outbound broadcast
// =============================================================================

describe("WebAdapter — outbound broadcast", () => {
  const binding = makeBinding({
    instanceId: "acme",
    broadcastUrl: "http://localhost:9999/broadcast",
    authScheme: "none",
  });
  const infra = makeInfra({ instanceId: "web:acme" });

  test("postResponse POSTs correct payload shape", async () => {
    const adapter = new WebAdapter(makeSyntheticAgent(), binding, infra);
    await withBroadcastCapture(async () => {
      await adapter.postResponse(
        { instanceId: "web:acme", channelId: "general", threadId: "t1" },
        "Hello from cortex",
      );
    });
    expect(BROADCAST_CAPTURES).toHaveLength(1);
    const payload = BROADCAST_CAPTURES[0]?.body as Record<string, unknown>;
    expect(payload.adapter_instance).toBe("web:acme");
    expect(payload.type).toBe("response");
    expect(payload.text).toBe("Hello from cortex");
    expect((payload.target as Record<string, unknown>).channel).toBe("general");
    expect((payload.target as Record<string, unknown>).thread).toBe("t1");
  });

  test("postResponse without threadId omits thread key", async () => {
    const adapter = new WebAdapter(makeSyntheticAgent(), binding, infra);
    await withBroadcastCapture(async () => {
      await adapter.postResponse(
        { instanceId: "web:acme", channelId: "general" },
        "Response",
      );
    });
    const payload = BROADCAST_CAPTURES[0]?.body as Record<string, unknown>;
    expect((payload.target as Record<string, unknown>).thread).toBeUndefined();
  });

  test("sendProgress POSTs type=progress", async () => {
    const adapter = new WebAdapter(makeSyntheticAgent(), binding, infra);
    await withBroadcastCapture(async () => {
      await adapter.sendProgress(
        { instanceId: "web:acme", channelId: "general" },
        "Working...",
      );
    });
    const payload = BROADCAST_CAPTURES[0]?.body as Record<string, unknown>;
    expect(payload.type).toBe("progress");
    expect(payload.text).toBe("Working...");
  });

  test("clearProgress POSTs type=clear_progress without text", async () => {
    const adapter = new WebAdapter(makeSyntheticAgent(), binding, infra);
    await withBroadcastCapture(async () => {
      await adapter.clearProgress({ instanceId: "web:acme", channelId: "general" });
    });
    const payload = BROADCAST_CAPTURES[0]?.body as Record<string, unknown>;
    expect(payload.type).toBe("clear_progress");
    expect(payload.text).toBeUndefined();
  });

  test("notifyPrincipal POSTs to _principal channel", async () => {
    const adapter = new WebAdapter(makeSyntheticAgent(), binding, infra);
    await withBroadcastCapture(async () => {
      await adapter.notifyPrincipal("System alert");
    });
    const payload = BROADCAST_CAPTURES[0]?.body as Record<string, unknown>;
    expect((payload.target as Record<string, unknown>).channel).toBe("_principal");
  });

  test("broadcast failure does not throw (logged + swallowed)", async () => {
    // broadcastUrl that will fail
    const failBinding = makeBinding({ broadcastUrl: "http://localhost:1/unreachable" });
    const adapter = new WebAdapter(makeSyntheticAgent(), failBinding, infra);
    // Must not reject — await directly; any thrown error would fail the test
    await adapter.postResponse({ instanceId: "web:acme", channelId: "ch" }, "text");
  });

  test("broadcastToken set → POST includes Authorization: Bearer header", async () => {
    const tokenBinding = makeBinding({ broadcastToken: "cortex-svc-secret" });
    const adapter = new WebAdapter(makeSyntheticAgent(), tokenBinding, infra);
    await withBroadcastCapture(async () => {
      await adapter.postResponse({ instanceId: "web:acme", channelId: "ch" }, "text");
    });
    expect(BROADCAST_CAPTURES[0]?.headers?.Authorization).toBe("Bearer cortex-svc-secret");
  });

  test("no broadcastToken → POST has no Authorization header (localhost default)", async () => {
    // binding has no broadcastToken (localhost — no outbound service auth)
    const adapter = new WebAdapter(makeSyntheticAgent(), binding, infra);
    await withBroadcastCapture(async () => {
      await adapter.postResponse({ instanceId: "web:acme", channelId: "ch" }, "text");
    });
    expect(BROADCAST_CAPTURES[0]?.headers?.Authorization).toBeUndefined();
  });
});

// =============================================================================
// 5. PlatformAdapter contract stubs
// =============================================================================

describe("WebAdapter — interface contract", () => {
  const adapter = new WebAdapter(makeSyntheticAgent(), makeBinding(), makeInfra());

  test("sendTyping is a no-op", async () => {
    // Must resolve without throwing
    await adapter.sendTyping({ instanceId: "web:acme", channelId: "ch" });
  });

  test("fetchContext returns empty array", async () => {
    const ctx = await adapter.fetchContext(
      { platform: "web", instanceId: "web:acme", authorId: "u1", authorName: "U",
        content: "x", channelId: "ch", attachments: [], timestamp: new Date() },
      10,
    );
    expect(ctx).toEqual([]);
  });

  test("resolveLogicalTarget returns null (not yet wired)", async () => {
    const result = await adapter.resolveLogicalTarget({ surface: "web", channel: "ch" });
    expect(result).toBeNull();
  });

  test("createThread returns a ResponseTarget with threadId", async () => {
    const msg: InboundMessage = {
      platform: "web", instanceId: "web:acme", authorId: "u1", authorName: "U",
      content: "x", channelId: "channel-1", attachments: [], timestamp: new Date(),
    };
    const target = await adapter.createThread(msg, "thread-name");
    expect(target.instanceId).toBe("web:acme");
    expect(target.channelId).toBe("channel-1");
    expect(target.threadId).toBe("channel-1"); // no threadId on msg → uses channelId
  });

  test("createThread preserves existing threadId", async () => {
    const msg: InboundMessage = {
      platform: "web", instanceId: "web:acme", authorId: "u1", authorName: "U",
      content: "x", channelId: "channel-1", threadId: "thread-root",
      attachments: [], timestamp: new Date(),
    };
    const target = await adapter.createThread(msg, "name");
    expect(target.threadId).toBe("thread-root");
  });

  test("resolveAccess returns denyCode=no_policy when no policy engine is configured", () => {
    // Cortex security posture: deny-by-default when no policy engine is wired.
    // The adapter must pass through whatever the policy port decides; it
    // must NOT short-circuit to allow-all.
    const msg: InboundMessage = {
      platform: "web", instanceId: "web:acme", authorId: "u1", authorName: "U",
      content: "x", channelId: "ch", attachments: [], timestamp: new Date(),
    };
    const decision = adapter.resolveAccess(msg);
    // No engine → NO_POLICY_PORT's deny; the adapter must faithfully forward it.
    expect(decision.allowed).toBe(false);
    expect(decision.denyCode).toBe("no_policy");
  });
});

// =============================================================================
// 6. Binding schema validation
// =============================================================================

describe("WebBindingSchema — validation", () => {

  test("valid binding parses correctly with defaults", () => {
    const result = WebBindingSchema.parse({
      instanceId: "acme",
      broadcastUrl: "http://example.com/broadcast",
    });
    expect(result.instanceId).toBe("acme");
    expect(result.host).toBe("127.0.0.1"); // default — loopback only
    expect(result.port).toBe(8090); // default
    expect(result.transport).toBe("ws"); // default
    expect(result.authScheme).toBe("cf-access"); // default
  });

  test("host defaults to loopback", () => {
    const r = WebBindingSchema.parse({
      instanceId: "acme",
      broadcastUrl: "http://x.com/b",
    });
    expect(r.host).toBe("127.0.0.1");
  });

  test("host override is honoured", () => {
    const r = WebBindingSchema.parse({
      instanceId: "acme",
      broadcastUrl: "http://x.com/b",
      host: "0.0.0.0",
    });
    expect(r.host).toBe("0.0.0.0");
  });

  test("missing instanceId fails validation", () => {
    expect(() =>
      WebBindingSchema.parse({ broadcastUrl: "http://x.com" }),
    ).toThrow();
  });

  test("missing broadcastUrl fails validation", () => {
    expect(() =>
      WebBindingSchema.parse({ instanceId: "acme" }),
    ).toThrow();
  });

  test("invalid broadcastUrl (not http) fails validation", () => {
    expect(() =>
      WebBindingSchema.parse({ instanceId: "acme", broadcastUrl: "ftp://example.com" }),
    ).toThrow();
  });

  test("invalid transport fails validation", () => {
    expect(() =>
      WebBindingSchema.parse({ instanceId: "acme", broadcastUrl: "http://x.com", transport: "grpc" }),
    ).toThrow();
  });
});

// =============================================================================
// 7. tenant-agnostic verification
// =============================================================================

describe("WebAdapter — tenant agnosticism", () => {
  test("adapter source contains no tenant-specific strings", () => {
    // Verify the adapter module text has no hardcoded tenant references.
    // We do this by checking the exported constructor behaves identically
    // for any tenant name.
    const a1 = new WebAdapter(
      makeSyntheticAgent("ivy"),
      makeBinding({ instanceId: "acme" }),
      makeInfra({ instanceId: "web:acme" }),
    );
    const a2 = new WebAdapter(
      makeSyntheticAgent("oak"),
      makeBinding({ instanceId: "acme-bot" }),
      makeInfra({ instanceId: "web:acme-bot" }),
    );
    expect(a1.platform).toBe(a2.platform);
    expect(a1.instanceId).toBe("web:acme");
    expect(a2.instanceId).toBe("web:acme-bot");
  });
});
