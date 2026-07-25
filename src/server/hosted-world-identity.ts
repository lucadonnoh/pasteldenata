import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  consumeWorldIdentityProof,
  createWorldIdentityChallenge,
} from "./world-identity-auth";

interface HostedWorldEnvironment {
  HOSTED_DEMO_MODE?: string | undefined;
  WORLD_DEMO_PRIVATE_KEY?: string | undefined;
}

export interface HostedWorldIdentity {
  address?: `0x${string}`;
  configured: boolean;
}

function parsePrivateKey(value: string | undefined): Hex | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const prefixed = normalized.startsWith("0x")
    ? normalized
    : `0x${normalized}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(prefixed)) {
    throw new Error(
      "WORLD_DEMO_PRIVATE_KEY must be a 32-byte hexadecimal EVM key.",
    );
  }
  return prefixed as Hex;
}

export function hostedWorldIdentity(
  environment: HostedWorldEnvironment = {
    HOSTED_DEMO_MODE: process.env.HOSTED_DEMO_MODE,
    WORLD_DEMO_PRIVATE_KEY: process.env.WORLD_DEMO_PRIVATE_KEY,
  },
): HostedWorldIdentity | undefined {
  if (environment.HOSTED_DEMO_MODE !== "true") return undefined;
  const key = parsePrivateKey(environment.WORLD_DEMO_PRIVATE_KEY);
  if (!key) return { configured: false };
  return {
    address: privateKeyToAccount(key).address,
    configured: true,
  };
}

/**
 * Prove control of the shared hosted identity against the same one-time,
 * plan-bound challenge used by local browser identities. The signing key
 * remains a Railway secret and is never returned by readiness or job APIs.
 */
export async function proveHostedWorldIdentity(
  planId: string,
  environment: HostedWorldEnvironment = {
    HOSTED_DEMO_MODE: process.env.HOSTED_DEMO_MODE,
    WORLD_DEMO_PRIVATE_KEY: process.env.WORLD_DEMO_PRIVATE_KEY,
  },
): Promise<`0x${string}` | undefined> {
  if (environment.HOSTED_DEMO_MODE !== "true") return undefined;
  const key = parsePrivateKey(environment.WORLD_DEMO_PRIVATE_KEY);
  if (!key) {
    throw new Error("The hosted World identity key is not configured.");
  }
  const account = privateKeyToAccount(key);
  const challenge = createWorldIdentityChallenge(account.address, planId);
  const signature = await account.signMessage({ message: challenge.message });
  return consumeWorldIdentityProof(
    {
      identityAgent: account.address,
      challengeId: challenge.challengeId,
      signature,
    },
    planId,
  );
}
