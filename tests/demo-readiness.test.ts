import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { getDemoReadiness } from "../src/server/demo-readiness";
import {
  HOMEPAGE_REQUIRED_HBAR,
  MARKET_LEAF_FLOAT_HBAR,
  MAX_MARKET_LEAF_COUNT,
  marketAgentRunwayHbar,
} from "../src/server/market-runway";

function mirrorBalance(hbar: number): typeof fetch {
  return async () =>
    Response.json({ balance: { balance: hbar * 1e8 } });
}

test("demo readiness requires both Hedera operator variables", async () => {
  const missing = await getDemoReadiness({}, mirrorBalance(10_000));
  assert.equal(missing.hedera.operatorIdConfigured, false);
  assert.equal(missing.hedera.operatorKeyConfigured, false);
  assert.equal(missing.hedera.ready, false);

  const blankKey = await getDemoReadiness(
    {
      HEDERA_OPERATOR_ID: "0.0.123",
      HEDERA_OPERATOR_KEY: " ",
    },
    mirrorBalance(10_000),
  );
  assert.equal(blankKey.hedera.ready, false);
});

test("demo readiness fails closed below the conservative market estimate", async () => {
  const result = await getDemoReadiness(
    {
      HEDERA_OPERATOR_ID: "0.0.123",
      HEDERA_OPERATOR_KEY: "private-key",
    },
    mirrorBalance(HOMEPAGE_REQUIRED_HBAR - 1),
  );

  assert.equal(result.hedera.operatorBalanceHbar, HOMEPAGE_REQUIRED_HBAR - 1);
  assert.equal(result.hedera.requiredHbar, HOMEPAGE_REQUIRED_HBAR);
  assert.equal(result.hedera.balanceOk, false);
  assert.equal(result.hedera.ready, false);
});

test("demo readiness accepts a funded worst-case first run", async () => {
  const result = await getDemoReadiness(
    {
      HEDERA_OPERATOR_ID: "0.0.123",
      HEDERA_OPERATOR_KEY: "private-key",
    },
    mirrorBalance(HOMEPAGE_REQUIRED_HBAR),
  );

  assert.equal(result.hedera.balanceOk, true);
  assert.equal(result.hedera.ready, true);
  assert.equal(marketAgentRunwayHbar(MAX_MARKET_LEAF_COUNT), 71);
  assert.equal(MARKET_LEAF_FLOAT_HBAR, 5);
});

test("demo readiness fails closed when Mirror Node is unavailable", async () => {
  const result = await getDemoReadiness(
    {
      HEDERA_OPERATOR_ID: "0.0.123",
      HEDERA_OPERATOR_KEY: "private-key",
    },
    async () => {
      throw new Error("offline");
    },
  );

  assert.equal(result.hedera.operatorBalanceHbar, null);
  assert.equal(result.hedera.ready, false);
});

test("demo readiness never returns Hedera credential values", async () => {
  const result = await getDemoReadiness(
    {
      HEDERA_OPERATOR_ID: "0.0.9999999999",
      HEDERA_OPERATOR_KEY: "secret-private-key",
    },
    mirrorBalance(10_000),
  );
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /0\.0\.9999999999/);
  assert.doesNotMatch(serialized, /secret-private-key/);
});

test("hosted demo readiness reports the server key without exposing it", async () => {
  const result = await getDemoReadiness(
    {
      HOSTED_DEMO_MODE: "true",
      ZEROG_SERVER_DEMO: "true",
      ZEROG_KEY: "sk-secret-hosted-demo-key",
      HEDERA_OPERATOR_ID: "0.0.123",
      HEDERA_OPERATOR_KEY: "hedera-secret",
    },
    mirrorBalance(10_000),
  );

  assert.deepEqual(result.zeroG, {
    mode: "hosted-demo",
    serverKeyConfigured: true,
    ready: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /sk-secret-hosted-demo-key/);
});

test("browser-key mode remains the default", async () => {
  const result = await getDemoReadiness({}, mirrorBalance(0));
  assert.deepEqual(result.zeroG, {
    mode: "browser-key",
    serverKeyConfigured: false,
    ready: false,
  });
});

test("hosted readiness verifies the shared World address without exposing its key", async () => {
  const privateKey =
    "0x1111111111111111111111111111111111111111111111111111111111111111";
  const account = privateKeyToAccount(privateKey);
  const lookedUp: string[] = [];
  const result = await getDemoReadiness(
    {
      HOSTED_DEMO_MODE: "true",
      ZEROG_SERVER_DEMO: "true",
      ZEROG_KEY: "sk-demo",
      WORLD_DEMO_PRIVATE_KEY: privateKey,
    },
    mirrorBalance(0),
    async (address) => {
      lookedUp.push(address);
      return "anonymous-human-id";
    },
  );

  assert.deepEqual(lookedUp, [account.address]);
  assert.deepEqual(result.world, {
    mode: "hosted-demo",
    identityAgent: account.address,
    configured: true,
    verified: true,
    identities: {
      verified: {
        identityAgent: account.address,
        verified: true,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /1111111111111111/);
  assert.doesNotMatch(JSON.stringify(result), /anonymous-human-id/);
});

test("hosted readiness reports a fresh visitor separately from the verified identity", async () => {
  const privateKey =
    "0x5555555555555555555555555555555555555555555555555555555555555555";
  const shared = privateKeyToAccount(privateKey);
  const lookedUp: string[] = [];
  const result = await getDemoReadiness(
    {
      HOSTED_DEMO_MODE: "true",
      ZEROG_SERVER_DEMO: "true",
      ZEROG_KEY: "sk-demo",
      WORLD_DEMO_PRIVATE_KEY: privateKey,
    },
    mirrorBalance(0),
    async (address) => {
      lookedUp.push(address);
      return address.toLowerCase() === shared.address.toLowerCase()
        ? "shared-human"
        : null;
    },
    {
      mode: "visitor",
      sessionId: "dd67b9cb-c9bc-49fa-a7fe-fe2bfd6ecc9a",
    },
  );

  assert.equal(result.world.identities?.verified.verified, true);
  assert.equal(result.world.identities?.visitor?.verified, false);
  assert.match(
    result.world.identities?.visitor?.identityAgent ?? "",
    /^0x[a-fA-F0-9]{40}$/,
  );
  assert.notEqual(
    result.world.identities?.visitor?.identityAgent,
    shared.address,
  );
  assert.equal(lookedUp.length, 2);
});
