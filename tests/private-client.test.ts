import assert from "node:assert/strict";
import test from "node:test";
import { ZeroGPrivateRouterClient } from "../src/zerog-private";

test("private Router client sends the documented TeeML controls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://router-api.0g.ai/v1/chat/completions",
    );
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get("X-0G-Provider-Trust-Mode"),
      "private",
    );
    assert.equal(headers.get("X-0G-Provider-Sort"), "latency");
    assert.equal(headers.get("Authorization"), "Bearer sk-test");

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.verify_tee, true);
    assert.deepEqual(body.messages, [
      { role: "user", content: "private intent" },
    ]);
    assert.equal(Object.hasOwn(body, "_e2ee"), false);

    return Response.json(
      {
        id: "chatcmpl-body-proof-key",
        choices: [{ message: { content: "{}" } }],
        x_0g_trace: {
          request_id: "request-1",
          provider: "0x0000000000000000000000000000000000000001",
          tee_verified: true,
        },
      },
      { headers: { "ZG-Res-Key": "header-proof-key" } },
    );
  };

  try {
    const completion = await new ZeroGPrivateRouterClient().complete({
      apiKey: "sk-test",
      baseUrl: "https://router-api.0g.ai/v1",
      request: {
        model: "0gm-1.0-35b-a3b",
        messages: [{ role: "user", content: "private intent" }],
      },
    });

    assert.equal(completion.chatId, "header-proof-key");
    assert.match(completion.responseText, /tee_verified/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private Router client aborts an unresponsive provider route", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason),
        { once: true },
      );
    });

  try {
    await assert.rejects(
      new ZeroGPrivateRouterClient(10).complete({
        apiKey: "sk-test",
        baseUrl: "https://router-api.0g.ai/v1",
        request: {
          model: "0gm-1.0-35b-a3b",
          messages: [{ role: "user", content: "private intent" }],
        },
      }),
      /0G private inference timed out after 0.01 seconds/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private Router client derives the provider proof key from the response ID", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      id: "chatcmpl-provider-proof-key",
      choices: [{ message: { content: "{}" } }],
    });

  try {
    const completion = await new ZeroGPrivateRouterClient().complete({
      apiKey: "sk-test",
      baseUrl: "https://router-api.0g.ai/v1",
      request: {
        model: "0gm-1.0-35b-a3b",
        messages: [{ role: "user", content: "private intent" }],
      },
    });
    assert.equal(completion.chatId, "provider-proof-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
