import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  consumeWorldIdentityProof,
  createWorldIdentityChallenge,
} from "../src/server/world-identity-auth";
import {
  hostedWorldIdentity,
  proveHostedWorldIdentity,
} from "../src/server/hosted-world-identity";

test("World identity proof requires and consumes the registered key signature", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = createWorldIdentityChallenge(account.address, "plan-1");
  const signature = await account.signMessage({ message: challenge.message });

  assert.equal(
    await consumeWorldIdentityProof(
      {
        identityAgent: account.address,
        challengeId: challenge.challengeId,
        signature,
      },
      "plan-1",
    ),
    account.address,
  );
  await assert.rejects(
    consumeWorldIdentityProof(
      {
        identityAgent: account.address,
        challengeId: challenge.challengeId,
        signature,
      },
      "plan-1",
    ),
    /unknown or already used/,
  );
});

test("World identity proof rejects address impersonation and plan replay", async () => {
  const victim = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey());
  const impersonation = createWorldIdentityChallenge(
    victim.address,
    "plan-victim",
  );
  const attackerSignature = await attacker.signMessage({
    message: impersonation.message,
  });
  await assert.rejects(
    consumeWorldIdentityProof(
      {
        identityAgent: victim.address,
        challengeId: impersonation.challengeId,
        signature: attackerSignature,
      },
      "plan-victim",
    ),
    /signature is invalid/,
  );

  const replay = createWorldIdentityChallenge(victim.address, "plan-a");
  const victimSignature = await victim.signMessage({ message: replay.message });
  await assert.rejects(
    consumeWorldIdentityProof(
      {
        identityAgent: victim.address,
        challengeId: replay.challengeId,
        signature: victimSignature,
      },
      "plan-b",
    ),
    /different plan/,
  );
});

test("hosted World identity proves control without exposing its signing key", async () => {
  const environment = {
    HOSTED_DEMO_MODE: "true",
    WORLD_DEMO_PRIVATE_KEY:
      "2222222222222222222222222222222222222222222222222222222222222222",
  };
  const publicIdentity = hostedWorldIdentity(environment);

  assert.equal(publicIdentity?.configured, true);
  assert.match(publicIdentity?.address ?? "", /^0x[a-fA-F0-9]{40}$/);
  assert.equal(
    await proveHostedWorldIdentity("hosted-plan", environment),
    publicIdentity?.address,
  );
  assert.doesNotMatch(JSON.stringify(publicIdentity), /2222222222222222/);
});
