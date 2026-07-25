import assert from "node:assert/strict";
import test from "node:test";
import { getDemoReadiness } from "../src/server/demo-readiness";

test("demo readiness requires both Hedera operator variables", () => {
  assert.deepEqual(getDemoReadiness({}), {
    hedera: {
      network: "testnet",
      operatorIdConfigured: false,
      operatorKeyConfigured: false,
      ready: false,
    },
  });

  assert.equal(
    getDemoReadiness({
      HEDERA_OPERATOR_ID: "0.0.123",
      HEDERA_OPERATOR_KEY: " ",
    }).hedera.ready,
    false,
  );

  assert.equal(
    getDemoReadiness({
      HEDERA_OPERATOR_ID: "0.0.123",
      HEDERA_OPERATOR_KEY: "private-key",
    }).hedera.ready,
    true,
  );
});

test("demo readiness never returns Hedera credential values", () => {
  const result = getDemoReadiness({
    HEDERA_OPERATOR_ID: "0.0.9695863",
    HEDERA_OPERATOR_KEY: "secret-private-key",
  });
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /0\.0\.9695863/);
  assert.doesNotMatch(serialized, /secret-private-key/);
});
