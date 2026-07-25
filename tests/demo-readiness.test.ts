import assert from "node:assert/strict";
import test from "node:test";
import { getDemoReadiness } from "../src/server/demo-readiness";

test("demo readiness requires both Hedera operator variables", async () => {
  const missing = await getDemoReadiness({});
  assert.equal(missing.hedera.operatorIdConfigured, false);
  assert.equal(missing.hedera.operatorKeyConfigured, false);
  assert.equal(missing.hedera.ready, false);

  const blankKey = await getDemoReadiness({
    HEDERA_OPERATOR_ID: "0.0.123",
    HEDERA_OPERATOR_KEY: " ",
  });
  assert.equal(blankKey.hedera.ready, false);
});

test("demo readiness requires operator balance, not just credentials", async () => {
  // 0.0.123 exists but is a system account the mirror reports; whatever the
  // lookup yields, readiness must never be true when the balance check
  // cannot confirm funds above the run requirement.
  const result = await getDemoReadiness({
    HEDERA_OPERATOR_ID: "0.0.0",
    HEDERA_OPERATOR_KEY: "private-key",
  });
  assert.equal(result.hedera.operatorIdConfigured, true);
  assert.equal(result.hedera.operatorKeyConfigured, true);
  if (!result.hedera.balanceOk) {
    assert.equal(result.hedera.ready, false);
  }
  assert.equal(typeof result.hedera.requiredHbar, "number");
});

test("demo readiness never returns Hedera credential values", async () => {
  const result = await getDemoReadiness({
    HEDERA_OPERATOR_ID: "0.0.9999999999",
    HEDERA_OPERATOR_KEY: "secret-private-key",
  });
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /0\.0\.9999999999/);
  assert.doesNotMatch(serialized, /secret-private-key/);
});
