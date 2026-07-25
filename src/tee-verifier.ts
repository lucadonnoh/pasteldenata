import {
  Contract,
  JsonRpcProvider,
  getAddress,
  hashMessage,
  recoverAddress,
} from "ethers";
import { z } from "zod";
import type {
  IndependentTeeVerification,
  ZeroGE2eeReceipt,
} from "./domain";
import { sha256Hex } from "./hash";
import { canonicalJson } from "./jcs";

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

export interface VerifiedTeeService {
  provider: string;
  url: string;
  model: string;
  verifiability: "TeeML";
  signingAddress: string;
}

export interface IndependentTeeVerificationInput {
  provider: string;
  chatId: string;
  requestContent: Record<string, unknown>;
  responseContent: Record<string, unknown>;
  e2ee: ZeroGE2eeReceipt;
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

export function verifyE2eeContentHashes({
  requestContent,
  responseContent,
  signedRequestHash,
  signedResponseHash,
}: {
  requestContent: Record<string, unknown>;
  responseContent: Record<string, unknown>;
  signedRequestHash: string;
  signedResponseHash: string;
}): {
  computedRequestHash: string;
  computedResponseHash: string;
} {
  const computedRequestHash = sha256Hex(canonicalJson(requestContent));
  const computedResponseHash = sha256Hex(canonicalJson(responseContent));

  if (computedRequestHash !== signedRequestHash.toLowerCase()) {
    throw new Error(
      `Independent TEE verification failed: signed request hash ${signedRequestHash} does not match the locally reconstructed E2EE request ${computedRequestHash}.`,
    );
  }
  if (computedResponseHash !== signedResponseHash.toLowerCase()) {
    throw new Error(
      `Independent TEE verification failed: signed response hash ${signedResponseHash} does not match the locally decrypted E2EE plan response ${computedResponseHash}.`,
    );
  }

  return { computedRequestHash, computedResponseHash };
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

export async function readVerifiedTeeService(
  provider: string,
): Promise<VerifiedTeeService> {
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
      "Independent TEE verification failed: the on-chain service record does not match the selected provider.",
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

  return {
    provider: providerAddress,
    url: service.url,
    model: service.model,
    verifiability: "TeeML",
    signingAddress: resolveSigningAddress(service),
  };
}

export class ZeroGIndependentTeeVerifier
  implements IndependentTeeVerifier
{
  async verify({
    provider,
    chatId,
    requestContent,
    responseContent,
    e2ee,
  }: IndependentTeeVerificationInput): Promise<IndependentTeeVerification> {
    const service = await readVerifiedTeeService(provider);
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
      signingAddress: service.signingAddress,
    });
    const signedHashes = extractSignedHashes(signed.text);
    if (
      !signedHashes.signedRequestHash ||
      !signedHashes.signedResponseHash
    ) {
      throw new Error(
        "Independent TEE verification failed: the signed payload does not contain valid request and response hashes.",
      );
    }
    const contentBinding = verifyE2eeContentHashes({
      requestContent,
      responseContent,
      signedRequestHash: signedHashes.signedRequestHash,
      signedResponseHash: signedHashes.signedResponseHash,
    });

    return {
      verified: true,
      method: "onchain-signer-eip191-e2ee-content-bound",
      chainId: ZEROG_MAINNET_CHAIN_ID,
      rpcUrl: ZEROG_MAINNET_RPC,
      serviceContract: ZEROG_INFERENCE_SERVICE_CONTRACT,
      provider: service.provider,
      chatId,
      serviceUrl,
      serviceModel: service.model,
      verifiability: "TeeML",
      signingAddress: service.signingAddress,
      recoveredAddress,
      signatureEndpoint,
      signedPayload: signed.text,
      signature: signed.signature,
      messageHash,
      signatureVerified: true,
      requestHashVerified: true,
      requestHashMethod: "jcs-decrypted-e2ee-request",
      computedRequestHash: contentBinding.computedRequestHash,
      responseHashVerified: true,
      responseHashMethod: "jcs-decrypted-e2ee-response",
      computedResponseHash: contentBinding.computedResponseHash,
      excludedResponseFields: e2ee.responseUnboundFields,
      normalizedResponseFields: [],
      signedRequestHash: signedHashes.signedRequestHash,
      signedResponseHash: signedHashes.signedResponseHash,
      e2ee,
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
