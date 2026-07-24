import { AccountId, Client, PrivateKey } from "@hashgraph/sdk";

export interface HederaContext {
  client: Client;
  operatorId: AccountId;
  operatorKey: PrivateKey;
  network: "testnet";
}

export function parsePrivateKey(value: string): PrivateKey {
  const raw = value.trim();
  const attempts: Array<(input: string) => PrivateKey> = [
    (input) => PrivateKey.fromStringDer(input),
    (input) => PrivateKey.fromStringECDSA(input),
    (input) => PrivateKey.fromStringED25519(input),
  ];
  for (const parse of attempts) {
    try {
      return parse(raw);
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

  const operatorId = AccountId.fromString(id);
  const operatorKey = parsePrivateKey(key);
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
