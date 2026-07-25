import { HOMEPAGE_REQUIRED_HBAR } from "./market-runway";
import { hostedWorldIdentity } from "./hosted-world-identity";
import { createHumanResolver } from "./world-gateway";

export interface DemoReadiness {
  zeroG: {
    mode: "browser-key" | "hosted-demo";
    serverKeyConfigured: boolean;
    ready: boolean;
  };
  world: {
    mode: "browser" | "hosted-demo";
    identityAgent?: `0x${string}`;
    configured: boolean;
    verified: boolean;
  };
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
  HOSTED_DEMO_MODE?: string | undefined;
  ZEROG_SERVER_DEMO?: string | undefined;
  ZEROG_KEY?: string | undefined;
  WORLD_DEMO_PRIVATE_KEY?: string | undefined;
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
    HOSTED_DEMO_MODE: process.env.HOSTED_DEMO_MODE,
    ZEROG_SERVER_DEMO: process.env.ZEROG_SERVER_DEMO,
    ZEROG_KEY: process.env.ZEROG_KEY,
    WORLD_DEMO_PRIVATE_KEY: process.env.WORLD_DEMO_PRIVATE_KEY,
  },
  fetcher: typeof fetch = fetch,
  worldLookup: (address: string) => Promise<string | null> = async (address) =>
    (await createHumanResolver()).lookupHuman(address),
): Promise<DemoReadiness> {
  const operatorIdConfigured = isConfigured(environment.HEDERA_OPERATOR_ID);
  const operatorKeyConfigured = isConfigured(environment.HEDERA_OPERATOR_KEY);
  const balance = await operatorBalanceHbar(
    environment.HEDERA_OPERATOR_ID,
    fetcher,
  );
  const balanceOk =
    balance !== null && balance >= HOMEPAGE_REQUIRED_HBAR;
  const hostedDemo =
    environment.HOSTED_DEMO_MODE === "true" &&
    environment.ZEROG_SERVER_DEMO === "true";
  const serverKeyConfigured = hostedDemo && isConfigured(environment.ZEROG_KEY);
  const sharedWorldIdentity = hostedWorldIdentity(environment);
  let worldVerified = false;
  if (sharedWorldIdentity?.configured && sharedWorldIdentity.address) {
    try {
      worldVerified = Boolean(
        await worldLookup(sharedWorldIdentity.address),
      );
    } catch {
      worldVerified = false;
    }
  }

  return {
    zeroG: {
      mode: hostedDemo ? "hosted-demo" : "browser-key",
      serverKeyConfigured,
      ready: serverKeyConfigured,
    },
    world: sharedWorldIdentity
      ? {
          mode: "hosted-demo",
          ...(sharedWorldIdentity.address
            ? { identityAgent: sharedWorldIdentity.address }
            : {}),
          configured: sharedWorldIdentity.configured,
          verified: worldVerified,
        }
      : {
          mode: "browser",
          configured: false,
          verified: false,
        },
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
