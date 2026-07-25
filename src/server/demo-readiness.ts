import { HOMEPAGE_REQUIRED_HBAR } from "./market-runway";

export interface DemoReadiness {
  hedera: {
    network: "testnet";
    operatorIdConfigured: boolean;
    operatorKeyConfigured: boolean;
    /** Live mirror balance; null when the lookup failed. */
    operatorBalanceHbar: number | null;
    /** Conservative worst-case first-run estimate; most floats are reusable. */
    requiredHbar: number;
    balanceOk: boolean;
    ready: boolean;
  };
}

async function operatorBalanceHbar(
  operatorId: string | undefined,
  fetcher: typeof fetch,
): Promise<number | null> {
  if (!operatorId?.trim()) return null;
  try {
    const response = await fetcher(
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
 * Report credentials and a conservative live balance estimate without ever
 * returning credential values or the operator account identifier.
 */
export async function getDemoReadiness(
  environment: HederaEnvironment = {
    HEDERA_OPERATOR_ID: process.env.HEDERA_OPERATOR_ID,
    HEDERA_OPERATOR_KEY: process.env.HEDERA_OPERATOR_KEY,
  },
  fetcher: typeof fetch = fetch,
): Promise<DemoReadiness> {
  const operatorIdConfigured = isConfigured(environment.HEDERA_OPERATOR_ID);
  const operatorKeyConfigured = isConfigured(environment.HEDERA_OPERATOR_KEY);
  const balance = await operatorBalanceHbar(
    environment.HEDERA_OPERATOR_ID,
    fetcher,
  );
  const balanceOk =
    balance !== null && balance >= HOMEPAGE_REQUIRED_HBAR;

  return {
    hedera: {
      network: "testnet",
      operatorIdConfigured,
      operatorKeyConfigured,
      operatorBalanceHbar: balance,
      requiredHbar: HOMEPAGE_REQUIRED_HBAR,
      balanceOk,
      ready: operatorIdConfigured && operatorKeyConfigured && balanceOk,
    },
  };
}
