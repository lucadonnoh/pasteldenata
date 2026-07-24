import {
  Contract,
  JsonRpcProvider,
  getAddress,
  hashMessage,
  recoverAddress,
} from "ethers";
import { z } from "zod";
import type { IndependentTeeVerification } from "./domain";
import { sha256Hex } from "./hash";

export const ZEROG_MAINNET_CHAIN_ID = 16661;
export const ZEROG_MAINNET_RPC = "https://evmrpc.0g.ai";

// 0G Compute InferenceServing contract, pinned to the official 0G Compute SDK
// v0.9.0 mainnet configuration.
export const ZEROG_INFERENCE_SERVICE_CONTRACT =
  "0x47340d900bdFec2BD393c626E12ea0656F938d84";

const SERVICE_ABI = [
  "function getService(address providerAddress) view returns ((address provider,string serviceType,string url,uint256 inputPrice,uint256 outputPrice,uint256 updatedAt,string model,string verifiability,string additionalInfo,address teeSignerAddress,bool teeSignerAcknowledged))",
] as const;

const SignatureResponseSchema = z.object({
  text: z.string(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  signing_address: z.string().optional(),
  signing_algo: z.string().optional(),
  provider_type: z.string().optional(),
  provider_identity: z.string().optional(),
  tls_cert_fingerprint: z.string().optional(),
});

const AdditionalInfoSchema = z
  .object({
    ProviderType: z.enum(["decentralized", "centralized"]).optional(),
    TargetSeparated: z.boolean().optional(),
    TargetTeeAddress: z.string().optional(),
  })
  .passthrough();

interface OnchainServiceRecord {
  provider: string;
  url: string;
  model: string;
  verifiability: string;
  additionalInfo: string;
  teeSignerAddress: string;
  teeSignerAcknowledged: boolean;
}

export interface IndependentTeeVerificationInput {
  provider: string;
  chatId: string;
  routerResponseText: string;
}

export interface IndependentTeeVerifier {
  verify(
    input: IndependentTeeVerificationInput,
  ): Promise<IndependentTeeVerification>;
}

export function verifyEip191Signature({
  signedText,
  signature,
  signingAddress,
}: {
  signedText: string;
  signature: string;
  signingAddress: string;
}): { messageHash: string; recoveredAddress: string } {
  const expectedSigningAddress = getAddress(signingAddress);
  const messageHash = hashMessage(signedText);
  const recoveredAddress = getAddress(
    recoverAddress(messageHash, signature),
  );
  if (recoveredAddress !== expectedSigningAddress) {
    throw new Error(
      "Independent TEE verification failed: the response signature does not recover to the on-chain TEE signer.",
    );
  }

  return { messageHash, recoveredAddress };
}

function extractSignedHashes(signedPayload: string): {
  signedRequestHash?: string;
  signedResponseHash?: string;
} {
  const [requestHash, responseHash] = signedPayload.split(":");

  return {
    ...(typeof requestHash === "string" &&
    /^[0-9a-fA-F]{64}$/.test(requestHash)
      ? { signedRequestHash: requestHash.toLowerCase() }
      : {}),
    ...(typeof responseHash === "string" &&
    /^[0-9a-fA-F]{64}$/.test(responseHash)
      ? { signedResponseHash: responseHash.toLowerCase() }
      : {}),
  };
}

type ResponseHashMethod =
  IndependentTeeVerification["responseHashMethod"];

interface ResponseHashCandidate {
  method: ResponseHashMethod;
  content: string;
  excludedResponseFields: [] | ["x_0g_trace"];
  normalizedResponseFields: [] | ["model"];
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error("Cannot canonicalize an unsupported JSON value.");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }

  throw new Error("Cannot canonicalize an unsupported JSON value.");
}

function stripTopLevelJsonField(
  json: string,
  fieldName: string,
): string | undefined {
  const objectStart = json.indexOf("{");
  const objectEnd = json.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) return undefined;

  const commas: number[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index <= objectEnd; index += 1) {
    const character = json[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    } else if (character === "," && depth === 1) {
      commas.push(index);
    }
  }

  const boundaries = [objectStart, ...commas, objectEnd];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startBoundary = boundaries[index];
    const endBoundary = boundaries[index + 1];
    if (startBoundary === undefined || endBoundary === undefined) {
      return undefined;
    }
    const start = startBoundary + 1;
    const end = endBoundary;
    const member = json.slice(start, end);
    try {
      const parsed = JSON.parse(`{${member}}`) as Record<
        string,
        unknown
      >;
      if (
        Object.keys(parsed).length === 1 &&
        Object.hasOwn(parsed, fieldName)
      ) {
        const removeStart =
          index === 0 ? start : startBoundary;
        const removeEnd =
          index === 0 && commas.length > 0
            ? endBoundary + 1
            : end;
        return json.slice(0, removeStart) + json.slice(removeEnd);
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function verifyResponseContentHash({
  routerResponseText,
  signedResponseHash,
  providerModel,
}: {
  routerResponseText: string;
  signedResponseHash: string;
  providerModel?: string;
}): {
  method: ResponseHashMethod;
  computedResponseHash: string;
  excludedResponseFields: [] | ["x_0g_trace"];
  normalizedResponseFields: [] | ["model"];
} {
  const expectedHash = signedResponseHash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error(
      "Independent TEE verification failed: the signed proof has no valid response hash.",
    );
  }

  const candidates: ResponseHashCandidate[] = [
    {
      method: "raw-router-response",
      content: routerResponseText,
      excludedResponseFields: [],
      normalizedResponseFields: [],
    },
  ];
  const rawWithoutTrace = stripTopLevelJsonField(
    routerResponseText,
    "x_0g_trace",
  );
  if (rawWithoutTrace !== undefined) {
    candidates.push({
      method: "raw-without-router-trace",
      content: rawWithoutTrace,
      excludedResponseFields: ["x_0g_trace"],
      normalizedResponseFields: [],
    });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(routerResponseText) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error(
      "Independent TEE verification failed: the Router response is not valid JSON.",
    );
  }
  const providerResponse = { ...parsed };
  delete providerResponse.x_0g_trace;
  candidates.push(
    {
      method: "json-without-router-trace",
      content: JSON.stringify(providerResponse),
      excludedResponseFields: ["x_0g_trace"],
      normalizedResponseFields: [],
    },
    {
      method: "jcs-without-router-trace",
      content: canonicalJson(providerResponse),
      excludedResponseFields: ["x_0g_trace"],
      normalizedResponseFields: [],
    },
  );
  if (
    providerModel &&
    typeof providerResponse.model === "string" &&
    providerResponse.model !== providerModel
  ) {
    const providerModelResponse = {
      ...providerResponse,
      model: providerModel,
    };
    candidates.push(
      {
        method: "json-without-router-trace-provider-model",
        content: JSON.stringify(providerModelResponse),
        excludedResponseFields: ["x_0g_trace"],
        normalizedResponseFields: ["model"],
      },
      {
        method: "jcs-without-router-trace-provider-model",
        content: canonicalJson(providerModelResponse),
        excludedResponseFields: ["x_0g_trace"],
        normalizedResponseFields: ["model"],
      },
    );
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.content)) continue;
    seen.add(candidate.content);
    const candidateHash = sha256Hex(candidate.content);
    if (candidateHash === expectedHash) {
      return {
        method: candidate.method,
        computedResponseHash: candidateHash,
        excludedResponseFields: candidate.excludedResponseFields,
        normalizedResponseFields: candidate.normalizedResponseFields,
      };
    }
  }

  const candidateHashes = candidates
    .map(
      (candidate) =>
        `${candidate.method}=${sha256Hex(candidate.content)}`,
    )
    .join(", ");
  throw new Error(
    `Independent TEE verification failed: signed response hash ${expectedHash} does not match the plan response received from the Router (${candidateHashes}).`,
  );
}

function resolveSigningAddress(service: OnchainServiceRecord): string {
  let additionalInfo: z.infer<typeof AdditionalInfoSchema>;
  try {
    additionalInfo = AdditionalInfoSchema.parse(
      JSON.parse(service.additionalInfo),
    );
  } catch {
    throw new Error(
      "Independent TEE verification failed: the provider has invalid on-chain additionalInfo.",
    );
  }

  const providerType = additionalInfo.ProviderType ?? "decentralized";
  if (
    additionalInfo.TargetSeparated === true &&
    providerType === "decentralized" &&
    additionalInfo.TargetTeeAddress
  ) {
    return getAddress(additionalInfo.TargetTeeAddress);
  }

  return getAddress(service.teeSignerAddress);
}

export class ZeroGIndependentTeeVerifier
  implements IndependentTeeVerifier
{
  async verify({
    provider,
    chatId,
    routerResponseText,
  }: IndependentTeeVerificationInput): Promise<IndependentTeeVerification> {
    const providerAddress = getAddress(provider);
    const rpc = new JsonRpcProvider(ZEROG_MAINNET_RPC);
    const network = await rpc.getNetwork();
    if (network.chainId !== BigInt(ZEROG_MAINNET_CHAIN_ID)) {
      throw new Error(
        `Independent TEE verification failed: expected 0G chain ${ZEROG_MAINNET_CHAIN_ID}, received ${network.chainId}.`,
      );
    }

    const serviceContract = new Contract(
      ZEROG_INFERENCE_SERVICE_CONTRACT,
      SERVICE_ABI,
      rpc,
    );
    const service = (await serviceContract.getFunction("getService")(
      providerAddress,
    )) as unknown as OnchainServiceRecord;

    if (getAddress(service.provider) !== providerAddress) {
      throw new Error(
        "Independent TEE verification failed: the on-chain service record does not match the Router provider.",
      );
    }
    if (service.verifiability !== "TeeML") {
      throw new Error(
        `Independent TEE verification failed: provider is ${service.verifiability || "not verifiable"}, not TeeML.`,
      );
    }
    if (service.teeSignerAcknowledged !== true) {
      throw new Error(
        "Independent TEE verification failed: the provider's TEE signer is not acknowledged on-chain.",
      );
    }

    const signingAddress = resolveSigningAddress(service);
    const serviceUrl = service.url.replace(/\/+$/, "");
    const signatureEndpoint =
      `${serviceUrl}/v1/proxy/signature/${encodeURIComponent(chatId)}` +
      `?model=${encodeURIComponent(service.model)}`;
    const signatureResponse = await fetch(signatureEndpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!signatureResponse.ok) {
      const errorBody = await signatureResponse.text();
      throw new Error(
        `Independent TEE verification failed: provider signature endpoint returned ${signatureResponse.status}${errorBody ? `: ${errorBody}` : "."}`,
      );
    }

    const signed = SignatureResponseSchema.parse(
      await signatureResponse.json(),
    );
    const { messageHash, recoveredAddress } = verifyEip191Signature({
      signedText: signed.text,
      signature: signed.signature,
      signingAddress,
    });
    const signedHashes = extractSignedHashes(signed.text);
    if (!signedHashes.signedResponseHash) {
      throw new Error(
        "Independent TEE verification failed: the signed payload contains no response hash.",
      );
    }
    const responseBinding = verifyResponseContentHash({
      routerResponseText,
      signedResponseHash: signedHashes.signedResponseHash,
      providerModel: service.model,
    });

    return {
      verified: true,
      method: "onchain-signer-eip191-response-bound",
      chainId: ZEROG_MAINNET_CHAIN_ID,
      rpcUrl: ZEROG_MAINNET_RPC,
      serviceContract: ZEROG_INFERENCE_SERVICE_CONTRACT,
      provider: providerAddress,
      chatId,
      serviceUrl,
      serviceModel: service.model,
      verifiability: "TeeML",
      signingAddress,
      recoveredAddress,
      signatureEndpoint,
      signedPayload: signed.text,
      signature: signed.signature,
      messageHash,
      signatureVerified: true,
      responseHashVerified: true,
      responseHashMethod: responseBinding.method,
      computedResponseHash: responseBinding.computedResponseHash,
      excludedResponseFields: responseBinding.excludedResponseFields,
      normalizedResponseFields: responseBinding.normalizedResponseFields,
      ...(signedHashes.signedRequestHash
        ? { signedRequestHash: signedHashes.signedRequestHash }
        : {}),
      signedResponseHash: signedHashes.signedResponseHash,
      ...(signed.provider_type
        ? { providerType: signed.provider_type }
        : {}),
      ...(signed.provider_identity
        ? { providerIdentity: signed.provider_identity }
        : {}),
      ...(signed.tls_cert_fingerprint
        ? { tlsCertFingerprint: signed.tls_cert_fingerprint }
        : {}),
    };
  }
}
