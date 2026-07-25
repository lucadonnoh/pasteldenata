import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { getAddress } from "ethers";
import { z } from "zod";
import type { ZeroGE2eeReceipt } from "./domain";
import { sha256Bytes } from "./hash";
import { canonicalJson } from "./jcs";
import { readVerifiedTeeService } from "./tee-verifier";

const VERSION = 1;
const KEM_ID = "0x0020";
const REQUEST_INFO = "0g-pc/v1/seal";
const RESPONSE_INFO = "0g-pc/v1/resp";
const SEALED_REQUEST_FIELDS = ["messages"] as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

const ProviderListSchema = z.object({
  data: z.array(
    z.object({
      address: z.string(),
      model_id: z.string(),
      canonical_id: z.string(),
      is_healthy: z.boolean(),
      tee_acknowledged: z.boolean().optional(),
      verifiability: z.string().optional(),
      trust_mode: z.string().optional(),
    }),
  ),
});

const ProviderPublicKeySchema = z.object({
  v: z.number().int(),
  kem_id: z.string(),
  enc_pub: z.string(),
  key_id: z.string(),
  signer_address: z.string(),
});

const ResponseE2eeSchema = z.object({
  v: z.number().int(),
  enc: z.string().min(1),
  sealed_fields: z.array(z.string().min(1)).min(1),
  unbound_fields: z.array(z.string().min(1)).optional(),
  final: z.boolean(),
  ciphertext: z.string().min(1),
});

type JsonObject = Record<string, unknown>;

export interface ZeroGE2eeCompletion {
  response: JsonObject;
  requestForProof: JsonObject;
  responseForProof: JsonObject;
  provider: string;
  chatId: string;
  receipt: ZeroGE2eeReceipt;
}

export interface ZeroGE2eeCompletionInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  request: JsonObject;
}

export interface ZeroGE2eeCompletionClient {
  complete(
    input: ZeroGE2eeCompletionInput,
  ): Promise<ZeroGE2eeCompletion>;
}

type TeeServiceReader = typeof readVerifiedTeeService;

function base64UrlEncode(value: ArrayBuffer | Uint8Array): string {
  const bytes =
    value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(paddingLength));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function resolveProofChatId(
  response: Response,
  responseId: unknown,
): string | undefined {
  const responseKey =
    response.headers.get("ZG-Res-Key") ??
    response.headers.get("zg-res-key");
  if (responseKey) return responseKey;
  if (typeof responseId !== "string") return undefined;
  return responseId.startsWith("chatcmpl-")
    ? responseId.slice("chatcmpl-".length)
    : responseId;
}

function assertJsonObject(
  value: unknown,
  description: string,
): asserts value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} is not a JSON object.`);
  }
}

function aadForEnvelope(
  envelope: JsonObject,
  unboundFields: readonly string[] = [],
): Uint8Array {
  const copy = { ...envelope };
  for (const field of unboundFields) delete copy[field];
  assertJsonObject(copy._e2ee, "0G E2EE metadata");
  const e2ee = { ...copy._e2ee };
  delete e2ee.ciphertext;
  copy._e2ee = e2ee;
  return textEncoder.encode(canonicalJson(copy));
}

function assertFieldSet(
  decrypted: JsonObject,
  sealedFields: readonly string[],
): void {
  const actual = Object.keys(decrypted).sort();
  const expected = [...sealedFields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(
      "0G E2EE response did not contain exactly its declared sealed fields.",
    );
  }
}

function validateUnboundFields(
  unboundFields: readonly string[],
  sealedFields: readonly string[],
): void {
  const seen = new Set<string>();
  for (const field of unboundFields) {
    if (
      field === "_e2ee" ||
      sealedFields.includes(field) ||
      seen.has(field)
    ) {
      throw new Error("0G E2EE response has invalid unbound fields.");
    }
    seen.add(field);
  }
}

async function resolveProvider(
  baseUrl: string,
  model: string,
): Promise<{
  address: string;
  canonicalModel: string;
}> {
  const response = await fetch(
    `${baseUrl}/providers?model_id=${encodeURIComponent(model)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(
      `0G provider discovery returned ${response.status}.`,
    );
  }
  const providers = ProviderListSchema.parse(await response.json()).data;
  const normalizedModel = model.toLowerCase();
  const provider = providers.find(
    (candidate) =>
      candidate.is_healthy &&
      candidate.tee_acknowledged !== false &&
      candidate.verifiability === "TeeML" &&
      candidate.trust_mode === "private" &&
      (candidate.canonical_id.toLowerCase() === normalizedModel ||
        candidate.model_id.toLowerCase() === normalizedModel),
  );
  if (!provider) {
    throw new Error(
      `0G returned no healthy private TeeML provider for ${model}.`,
    );
  }
  return {
    address: getAddress(provider.address),
    canonicalModel: provider.canonical_id,
  };
}

function parseRouterError(body: string, status: number): Error {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return new Error(
      `0G Router returned ${status}: ${parsed.error?.message ?? body}`,
    );
  } catch {
    return new Error(`0G Router returned ${status}: ${body || "unknown error"}`);
  }
}

export class ZeroGE2eeClient implements ZeroGE2eeCompletionClient {
  constructor(
    private readonly serviceReader: TeeServiceReader =
      readVerifiedTeeService,
  ) {}

  async complete({
    apiKey,
    baseUrl,
    model,
    request,
  }: ZeroGE2eeCompletionInput): Promise<ZeroGE2eeCompletion> {
    if (!Object.hasOwn(request, "messages")) {
      throw new Error("0G E2EE requires a messages field.");
    }

    const selected = await resolveProvider(baseUrl, model);
    const service = await this.serviceReader(selected.address);
    if (
      service.model.toLowerCase() !==
      selected.canonicalModel.toLowerCase()
    ) {
      throw new Error(
        "0G provider discovery does not match the model in its on-chain service record.",
      );
    }
    const provider = getAddress(service.provider);
    const signerAddress = getAddress(service.signingAddress);
    const serviceUrl = service.url.replace(/\/+$/, "");
    let parsedServiceUrl: URL;
    try {
      parsedServiceUrl = new URL(serviceUrl);
    } catch {
      throw new Error("0G provider has an invalid on-chain service URL.");
    }
    if (parsedServiceUrl.protocol !== "https:") {
      throw new Error(
        "0G provider E2EE key delivery requires an HTTPS on-chain service URL.",
      );
    }
    const publicKeyEndpoint = `${serviceUrl}/v1/e2ee/pubkey`;
    const publicKeyResponse = await fetch(publicKeyEndpoint, {
      headers: { Accept: "application/json" },
    });
    if (!publicKeyResponse.ok) {
      throw new Error(
        `0G provider E2EE key endpoint returned ${publicKeyResponse.status}.`,
      );
    }
    const publicKeyAdvertisement = ProviderPublicKeySchema.parse(
      await publicKeyResponse.json(),
    );
    if (
      publicKeyAdvertisement.v !== VERSION ||
      publicKeyAdvertisement.kem_id !== KEM_ID
    ) {
      throw new Error("0G provider advertised an unsupported E2EE suite.");
    }
    if (
      getAddress(publicKeyAdvertisement.signer_address) !== signerAddress
    ) {
      throw new Error(
        "0G provider E2EE key does not name the on-chain TEE signer.",
      );
    }

    const providerPublicKey = base64UrlDecode(
      publicKeyAdvertisement.enc_pub,
    );
    if (providerPublicKey.length !== 32) {
      throw new Error("0G provider E2EE key is not an X25519 key.");
    }
    const computedKeyId = base64UrlEncode(
      sha256Bytes(providerPublicKey).slice(0, 8),
    );
    if (computedKeyId !== publicKeyAdvertisement.key_id) {
      throw new Error("0G provider E2EE key ID does not match its key.");
    }

    const requestForProof: JsonObject = {
      ...request,
      model: selected.canonicalModel,
    };
    const sealedObject = {
      messages: requestForProof.messages,
    };
    const clearRequest = { ...requestForProof };
    delete clearRequest.messages;

    const responseKeyPair = await suite.kem.generateKeyPair();
    const responsePublicKey = await suite.kem.serializePublicKey(
      responseKeyPair.publicKey,
    );
    const recipientPublicKey = await suite.kem.deserializePublicKey(
      providerPublicKey,
    );
    const requestSender = await suite.createSenderContext({
      recipientPublicKey,
      info: textEncoder.encode(REQUEST_INFO),
    });
    const requestMetadata: JsonObject = {
      v: VERSION,
      kem_id: KEM_ID,
      key_id: computedKeyId,
      signer_addr: signerAddress,
      client_eph_pub: base64UrlEncode(responsePublicKey),
      enc: base64UrlEncode(requestSender.enc),
      sealed_fields: [...SEALED_REQUEST_FIELDS],
    };
    const envelope: JsonObject = {
      ...clearRequest,
      _e2ee: requestMetadata,
    };
    const requestCiphertext = await requestSender.seal(
      textEncoder.encode(JSON.stringify(sealedObject)),
      aadForEnvelope(envelope),
    );
    envelope._e2ee = {
      ...requestMetadata,
      ciphertext: base64UrlEncode(requestCiphertext),
    };

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-0G-Provider-Allow-Fallbacks": "false",
        "X-0G-Provider-Address": provider,
        "X-0G-Provider-Trust-Mode": "private",
      },
      body: JSON.stringify(envelope),
    });
    const responseText = await response.text();
    if (!response.ok) throw parseRouterError(responseText, response.status);

    let sealedResponse: unknown;
    try {
      sealedResponse = JSON.parse(responseText);
    } catch {
      throw new Error("0G Router returned a non-JSON E2EE response.");
    }
    assertJsonObject(sealedResponse, "0G E2EE response");
    const responseMetadata = ResponseE2eeSchema.parse(
      sealedResponse._e2ee,
    );
    if (
      responseMetadata.v !== VERSION ||
      responseMetadata.final !== true
    ) {
      throw new Error(
        "0G E2EE response is incomplete or uses an unsupported version.",
      );
    }
    const unboundFields = responseMetadata.unbound_fields ?? [];
    validateUnboundFields(
      unboundFields,
      responseMetadata.sealed_fields,
    );

    const responseRecipient = await suite.createRecipientContext({
      recipientKey: responseKeyPair.privateKey,
      enc: base64UrlDecode(responseMetadata.enc),
      info: textEncoder.encode(RESPONSE_INFO),
    });
    let decryptedBytes: ArrayBuffer;
    try {
      decryptedBytes = await responseRecipient.open(
        base64UrlDecode(responseMetadata.ciphertext),
        aadForEnvelope(sealedResponse, unboundFields),
      );
    } catch {
      throw new Error(
        "0G E2EE response authentication failed; its sealed plan or bound metadata was changed.",
      );
    }

    let decrypted: unknown;
    try {
      decrypted = JSON.parse(textDecoder.decode(decryptedBytes));
    } catch {
      throw new Error("0G E2EE response decrypted to invalid JSON.");
    }
    assertJsonObject(decrypted, "0G E2EE decrypted response");
    assertFieldSet(decrypted, responseMetadata.sealed_fields);

    const reconstructed = { ...sealedResponse };
    delete reconstructed._e2ee;
    for (const field of responseMetadata.sealed_fields) {
      if (Object.hasOwn(reconstructed, field)) {
        throw new Error(
          `0G E2EE sealed field ${field} collided with cleartext response data.`,
        );
      }
      reconstructed[field] = decrypted[field];
    }
    const responseForProof = { ...reconstructed };
    for (const field of unboundFields) delete responseForProof[field];

    const chatId = resolveProofChatId(response, reconstructed.id);
    if (!chatId) {
      throw new Error(
        "0G returned no proof key for its E2EE response signature.",
      );
    }

    return {
      response: reconstructed,
      requestForProof,
      responseForProof,
      provider,
      chatId,
      receipt: {
        protocol: "0g-pc-e2ee-v1",
        cipherSuite:
          "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20Poly1305",
        providerPublicKeyEndpoint: publicKeyEndpoint,
        providerEncryptionKey: publicKeyAdvertisement.enc_pub,
        encryptionKeyId: computedKeyId,
        encryptionKeySignerMatchesOnchain: true,
        encryptionKeyAttestationVerified: false,
        requestSealedFields: [...SEALED_REQUEST_FIELDS],
        responseSealedFields: responseMetadata.sealed_fields,
        responseUnboundFields: unboundFields,
        requestEncrypted: true,
        responseEncrypted: true,
        responseDecryptedLocally: true,
      },
    };
  }
}
