export interface DemoReadiness {
  hedera: {
    network: "testnet";
    operatorIdConfigured: boolean;
    operatorKeyConfigured: boolean;
    /** Live mirror balance; null when the lookup failed. */
    operatorBalanceHbar: number | null;
    /** Rough front for one market run (floats return afterwards). */
    requiredHbar: number;
    balanceOk: boolean;
    ready: boolean;
  };
}

const REQUIRED_HBAR = 90;

async function operatorBalanceHbar(
  operatorId: string | undefined,
): Promise<number | null> {
  if (!operatorId?.trim()) return null;
  try {
    const response = await fetch(
      `https://testnet.mirrornode.hedera.com/api/v1/accounts/${operatorId.trim()}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      balance?: { balance?: number };
    };
    return (data.balance?.balance ?? 0) / 1e8;
  } catch {
    return null;
  }
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
export async function getDemoReadiness(
  environment: HederaEnvironment = {
    HEDERA_OPERATOR_ID: process.env.HEDERA_OPERATOR_ID,
    HEDERA_OPERATOR_KEY: process.env.HEDERA_OPERATOR_KEY,
  },
): Promise<DemoReadiness> {
  const operatorIdConfigured = isConfigured(environment.HEDERA_OPERATOR_ID);
  const operatorKeyConfigured = isConfigured(environment.HEDERA_OPERATOR_KEY);
  const balance = await operatorBalanceHbar(environment.HEDERA_OPERATOR_ID);
  const balanceOk = balance !== null && balance >= REQUIRED_HBAR;

  return {
    hedera: {
      network: "testnet",
      operatorIdConfigured,
      operatorKeyConfigured,
      operatorBalanceHbar: balance,
      requiredHbar: REQUIRED_HBAR,
      balanceOk,
      ready: operatorIdConfigured && operatorKeyConfigured && balanceOk,
    },
  };
}
