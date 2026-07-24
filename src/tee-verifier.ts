import {
  Contract,
  JsonRpcProvider,
  getAddress,
  hashMessage,
  recoverAddress,
} from "ethers";
import { z } from "zod";
import type { IndependentTeeVerification } from "./domain";

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
      throw new Error(
        `Independent TEE verification failed: provider signature endpoint returned ${signatureResponse.status}.`,
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

    return {
      verified: true,
      method: "onchain-signer-eip191",
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
      ...signedHashes,
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
