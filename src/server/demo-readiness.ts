export interface DemoReadiness {
  hedera: {
    network: "testnet";
    operatorIdConfigured: boolean;
    operatorKeyConfigured: boolean;
    ready: boolean;
  };
}

interface HederaEnvironment {
  HEDERA_OPERATOR_ID?: string | undefined;
  HEDERA_OPERATOR_KEY?: string | undefined;
}

function isConfigured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * Report only whether local coordinator credentials are present. Never return
 * credential values (or derived identifiers) to the browser.
 */
export function getDemoReadiness(
  environment: HederaEnvironment = {
    HEDERA_OPERATOR_ID: process.env.HEDERA_OPERATOR_ID,
    HEDERA_OPERATOR_KEY: process.env.HEDERA_OPERATOR_KEY,
  },
): DemoReadiness {
  const operatorIdConfigured = isConfigured(environment.HEDERA_OPERATOR_ID);
  const operatorKeyConfigured = isConfigured(environment.HEDERA_OPERATOR_KEY);

  return {
    hedera: {
      network: "testnet",
      operatorIdConfigured,
      operatorKeyConfigured,
      ready: operatorIdConfigured && operatorKeyConfigured,
    },
  };
}
