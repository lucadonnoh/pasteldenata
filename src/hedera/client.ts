import { AccountId, Client, PrivateKey } from "@hashgraph/sdk";

export interface HederaContext {
  client: Client;
  operatorId: AccountId;
  operatorKey: PrivateKey;
  network: "testnet";
}

export type RawPrivateKeyType = "ECDSA" | "ED25519";

export function parsePrivateKey(
  value: string,
  rawKeyType: RawPrivateKeyType = "ECDSA",
): PrivateKey {
  const raw = value.trim();
  const normalized = raw.startsWith("0x") ? raw.slice(2) : raw;
  const isBarePrivateKey = /^[0-9a-fA-F]{64}$/.test(normalized);
  const rawAttempts: Array<(input: string) => PrivateKey> =
    rawKeyType === "ED25519"
      ? [
          (input) => PrivateKey.fromStringED25519(input),
          (input) => PrivateKey.fromStringECDSA(input),
        ]
      : [
          (input) => PrivateKey.fromStringECDSA(input),
          (input) => PrivateKey.fromStringED25519(input),
        ];
  const attempts: Array<(input: string) => PrivateKey> = isBarePrivateKey
    ? rawAttempts
    : [
        (input) => PrivateKey.fromStringDer(input),
        ...rawAttempts,
      ];
  for (const parse of attempts) {
    try {
      return parse(isBarePrivateKey ? normalized : raw);
    } catch {
      // Try the next encoding.
    }
  }
  throw new Error(
    "HEDERA_OPERATOR_KEY is not a valid DER, ECDSA, or ED25519 private key.",
  );
}

export function connectHedera(): HederaContext {
  const id = process.env.HEDERA_OPERATOR_ID;
  const key = process.env.HEDERA_OPERATOR_KEY;
  if (!id || !key) {
    throw new Error(
      "HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are missing. Create a free " +
        "testnet account at https://portal.hedera.com and add them to .env.",
    );
  }

  const configuredKeyType =
    process.env.HEDERA_OPERATOR_KEY_TYPE?.trim().toUpperCase();
  if (
    configuredKeyType &&
    configuredKeyType !== "ECDSA" &&
    configuredKeyType !== "ED25519"
  ) {
    throw new Error(
      "HEDERA_OPERATOR_KEY_TYPE must be ECDSA or ED25519.",
    );
  }
  const operatorId = AccountId.fromString(id);
  const operatorKey = parsePrivateKey(
    key,
    (configuredKeyType as RawPrivateKeyType | undefined) ?? "ECDSA",
  );
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  return { client, operatorId, operatorKey, network: "testnet" };
}

export function hashscanTxUrl(transactionId: string): string {
  const [payer, timestamp] = transactionId.split("@");
  if (!timestamp) {
    return `https://hashscan.io/testnet/transaction/${transactionId}`;
  }
  return `https://hashscan.io/testnet/transaction/${payer}-${timestamp.replace(".", "-")}`;
}

export function hashscanTopicUrl(topicId: string): string {
  return `https://hashscan.io/testnet/topic/${topicId}`;
}
