import { createHmac } from "node:crypto";
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

export type HostedWorldIdentitySelection =
  | { mode: "verified" }
  | { mode: "visitor"; sessionId: string };

export interface HostedWorldIdentity {
  address?: `0x${string}`;
  configured: boolean;
}

const WORLD_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function identityPrivateKey(
  rootKey: Hex,
  selection: HostedWorldIdentitySelection,
): Hex {
  if (selection.mode === "verified") return rootKey;
  if (!WORLD_SESSION_ID.test(selection.sessionId)) {
    throw new Error("Hosted World visitor session is invalid.");
  }

  // HMAC makes each browser session a stable, unlinkable identity while the
  // Railway-only root remains sufficient to prove control. Almost every
  // 256-bit result is a valid secp256k1 scalar; retry deterministically for
  // the vanishingly rare invalid result.
  for (let counter = 0; counter < 4; counter += 1) {
    const candidate = `0x${createHmac(
      "sha256",
      Buffer.from(rootKey.slice(2), "hex"),
    )
      .update(`pastel-world-visitor-v1|${selection.sessionId}|${counter}`)
      .digest("hex")}` as Hex;
    try {
      privateKeyToAccount(candidate);
      return candidate;
    } catch {
      // Try the next domain-separated digest.
    }
  }
  throw new Error("Could not derive the hosted World visitor identity.");
}

export function hostedWorldIdentity(
  environment: HostedWorldEnvironment = {
    HOSTED_DEMO_MODE: process.env.HOSTED_DEMO_MODE,
    WORLD_DEMO_PRIVATE_KEY: process.env.WORLD_DEMO_PRIVATE_KEY,
  },
  selection: HostedWorldIdentitySelection = { mode: "verified" },
): HostedWorldIdentity | undefined {
  if (environment.HOSTED_DEMO_MODE !== "true") return undefined;
  const rootKey = parsePrivateKey(environment.WORLD_DEMO_PRIVATE_KEY);
  if (!rootKey) return { configured: false };
  const key = identityPrivateKey(rootKey, selection);
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
  selection: HostedWorldIdentitySelection = { mode: "verified" },
  environment: HostedWorldEnvironment = {
    HOSTED_DEMO_MODE: process.env.HOSTED_DEMO_MODE,
    WORLD_DEMO_PRIVATE_KEY: process.env.WORLD_DEMO_PRIVATE_KEY,
  },
): Promise<`0x${string}` | undefined> {
  if (environment.HOSTED_DEMO_MODE !== "true") return undefined;
  const rootKey = parsePrivateKey(environment.WORLD_DEMO_PRIVATE_KEY);
  if (!rootKey) {
    throw new Error("The hosted World identity key is not configured.");
  }
  const key = identityPrivateKey(rootKey, selection);
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
