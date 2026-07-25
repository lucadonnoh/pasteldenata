import assert from "node:assert/strict";
import test from "node:test";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { sha256Bytes } from "../src/hash";
import { canonicalJson } from "../src/jcs";
import { ZeroGE2eeClient } from "../src/zerog-e2ee";

const PROVIDER = "0x0000000000000000000000000000000000000001";
const SIGNER = "0x0000000000000000000000000000000000000002";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

function b64Encode(value: ArrayBuffer | Uint8Array): string {
  const bytes =
    value instanceof Uint8Array ? value : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}

function b64Decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function asObject(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function aad(
  envelope: Record<string, unknown>,
  unboundFields: string[] = [],
): Uint8Array {
  const copy = structuredClone(envelope);
  for (const field of unboundFields) delete copy[field];
  const metadata = asObject(copy._e2ee);
  delete metadata.ciphertext;
  return encoder.encode(canonicalJson(copy));
}

test("browser E2EE client seals messages and opens authenticated choices", async () => {
  const originalFetch = globalThis.fetch;
  const providerKeys = await suite.kem.generateKeyPair();
  const providerPublicKey = await suite.kem.serializePublicKey(
    providerKeys.publicKey,
  );
  const keyId = b64Encode(
    sha256Bytes(new Uint8Array(providerPublicKey)).slice(0, 8),
  );

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/providers?")) {
      return Response.json({
        data: [
          {
            address: PROVIDER,
            model_id: "0GM-1.0-35B-A3B",
            canonical_id: "0gm-1.0-35b-a3b",
            is_healthy: true,
            tee_acknowledged: true,
            verifiability: "TeeML",
            trust_mode: "private",
          },
        ],
      });
    }
    if (url === "https://provider.example/v1/e2ee/pubkey") {
      return Response.json({
        v: 1,
        kem_id: "0x0020",
        enc_pub: b64Encode(providerPublicKey),
        key_id: keyId,
        signer_address: SIGNER,
      });
    }

    assert.equal(
      url,
      "https://router-api.0g.ai/v1/chat/completions",
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-0G-Provider-Address"), PROVIDER);
    assert.equal(
      headers.get("X-0G-Provider-Allow-Fallbacks"),
      "false",
    );
    const requestEnvelope = asObject(
      JSON.parse(String(init?.body)),
    );
    assert.equal(Object.hasOwn(requestEnvelope, "messages"), false);
    const requestMetadata = asObject(requestEnvelope._e2ee);
    const providerRecipient = await suite.createRecipientContext({
      recipientKey: providerKeys.privateKey,
      enc: b64Decode(String(requestMetadata.enc)),
      info: encoder.encode("0g-pc/v1/seal"),
    });
    const openedRequest = asObject(
      JSON.parse(
        decoder.decode(
          await providerRecipient.open(
            b64Decode(String(requestMetadata.ciphertext)),
            aad(requestEnvelope),
          ),
        ),
      ),
    );
    assert.match(
      JSON.stringify(openedRequest.messages),
      /private interop intent/,
    );

    const clientPublicKey = await suite.kem.deserializePublicKey(
      b64Decode(String(requestMetadata.client_eph_pub)),
    );
    const responseSender = await suite.createSenderContext({
      recipientPublicKey: clientPublicKey,
      info: encoder.encode("0g-pc/v1/resp"),
    });
    const choices = [
      {
        message: {
          content: '{"occasionTitle":"Private plan"}',
        },
      },
    ];
    const responseMetadata: Record<string, unknown> = {
      v: 1,
      enc: b64Encode(responseSender.enc),
      sealed_fields: ["choices"],
      unbound_fields: ["x_0g_trace"],
      final: true,
    };
    const responseEnvelope: Record<string, unknown> = {
      id: "chatcmpl-proof-key",
      model: "0gm-1.0-35b-a3b",
      _e2ee: responseMetadata,
    };
    responseMetadata.ciphertext = b64Encode(
      await responseSender.seal(
        encoder.encode(JSON.stringify({ choices })),
        aad(responseEnvelope, ["x_0g_trace"]),
      ),
    );
    responseEnvelope.x_0g_trace = {
      request_id: "request-1",
      provider: PROVIDER,
      tee_verified: true,
    };
    return Response.json(responseEnvelope, {
      headers: { "ZG-Res-Key": "proof-key" },
    });
  };

  try {
    const client = new ZeroGE2eeClient(async (provider) => ({
      provider,
      url: "https://provider.example",
      model: "0GM-1.0-35B-A3B",
      verifiability: "TeeML",
      signingAddress: SIGNER,
    }));
    const result = await client.complete({
      apiKey: "sk-test",
      baseUrl: "https://router-api.0g.ai/v1",
      model: "0gm-1.0-35b-a3b",
      request: {
        model: "0gm-1.0-35b-a3b",
        verify_tee: true,
        messages: [
          { role: "user", content: "private interop intent" },
        ],
      },
    });

    assert.equal(result.chatId, "proof-key");
    assert.equal(result.receipt.requestEncrypted, true);
    assert.equal(result.receipt.responseDecryptedLocally, true);
    assert.match(JSON.stringify(result.response.choices), /Private plan/);
    assert.equal(Object.hasOwn(result.responseForProof, "x_0g_trace"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
