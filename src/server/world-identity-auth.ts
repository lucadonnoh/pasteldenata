import { randomUUID } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 100;

interface PendingChallenge {
  address: `0x${string}`;
  planId: string;
  message: string;
  expiresAt: number;
}

export interface WorldIdentityChallenge {
  challengeId: string;
  message: string;
  expiresAt: number;
}

export interface WorldIdentityProof {
  identityAgent: `0x${string}`;
  challengeId: string;
  signature: Hex;
}

const store = globalThis as unknown as {
  __pastelWorldIdentityChallenges?: Map<string, PendingChallenge>;
};
const challenges = (store.__pastelWorldIdentityChallenges ??= new Map());

function pruneChallenges(now: number): void {
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(id);
  }
  while (challenges.size >= MAX_PENDING_CHALLENGES) {
    const oldest = challenges.keys().next().value as string | undefined;
    if (!oldest) break;
    challenges.delete(oldest);
  }
}

/**
 * Issue a short-lived authorization scoped to one local settlement plan.
 * The message is intentionally human-readable in wallet tooling.
 */
export function createWorldIdentityChallenge(
  identityAgent: string,
  planId: string,
  now = Date.now(),
): WorldIdentityChallenge {
  if (!isAddress(identityAgent)) {
    throw new Error("World identity agent is not a valid EVM address.");
  }
  if (!planId.trim() || planId.length > 160) {
    throw new Error("World identity challenge has an invalid plan id.");
  }
  pruneChallenges(now);
  const address = getAddress(identityAgent);
  const challengeId = randomUUID();
  const expiresAt = now + CHALLENGE_TTL_MS;
  const message = [
    "Pastel de Nata World identity authorization",
    `Identity agent: ${address}`,
    `Plan: ${planId}`,
    `Challenge: ${challengeId}`,
    `Expires at: ${new Date(expiresAt).toISOString()}`,
    "Scope: request auction credentials for this local settlement only.",
  ].join("\n");
  challenges.set(challengeId, {
    address,
    planId,
    message,
    expiresAt,
  });
  return { challengeId, message, expiresAt };
}

/**
 * Verify ownership of the AgentBook address and consume the challenge before
 * returning. Deleting before signature verification also prevents retries
 * from turning the endpoint into a signature oracle.
 */
export async function consumeWorldIdentityProof(
  proof: WorldIdentityProof,
  expectedPlanId: string,
  now = Date.now(),
): Promise<`0x${string}`> {
  const challenge = challenges.get(proof.challengeId);
  challenges.delete(proof.challengeId);
  if (!challenge) {
    throw new Error("World identity challenge is unknown or already used.");
  }
  if (challenge.expiresAt <= now) {
    throw new Error("World identity challenge expired.");
  }
  if (challenge.planId !== expectedPlanId) {
    throw new Error("World identity challenge belongs to a different plan.");
  }
  if (
    !isAddress(proof.identityAgent) ||
    getAddress(proof.identityAgent) !== challenge.address
  ) {
    throw new Error("World identity proof address does not match its challenge.");
  }
  const valid = await verifyMessage({
    address: challenge.address,
    message: challenge.message,
    signature: proof.signature,
  });
  if (!valid) {
    throw new Error("World identity signature is invalid.");
  }
  return challenge.address;
}
