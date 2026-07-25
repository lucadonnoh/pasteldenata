import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Category } from "../domain";
import { runtimeDataDirectory } from "../server/runtime-data";
import type { StoredAccount } from "./infra";

export interface LeafWalletRecoveryRecord {
  version: 1;
  network: "testnet";
  accountId: string;
  privateKey: string;
  planId: string;
  mandateId: string;
  category: Category;
  createdAt: string;
}

function vaultDirectory(baseDirectory: string): string {
  return resolve(baseDirectory, ".pasteldenata", "hedera-wallets");
}

function recoveryPath(baseDirectory: string, accountId: string): string {
  return resolve(
    vaultDirectory(baseDirectory),
    `${accountId.replaceAll(".", "_")}.json`,
  );
}

/**
 * Persist a testnet leaf key locally before funding the account. The directory
 * and record are owner-only and ignored by git, so a purchased claim remains
 * recoverable without exposing the key through the browser-facing result.
 */
export function persistLeafWallet(
  wallet: StoredAccount,
  metadata: {
    planId: string;
    mandateId: string;
    category: Category;
  },
  baseDirectory = runtimeDataDirectory(),
): string {
  const directory = vaultDirectory(baseDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const path = recoveryPath(baseDirectory, wallet.accountId);
  const record: LeafWalletRecoveryRecord = {
    version: 1,
    network: "testnet",
    accountId: wallet.accountId,
    privateKey: wallet.privateKey,
    planId: metadata.planId,
    mandateId: metadata.mandateId,
    category: metadata.category,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return path;
}

export function readLeafWallet(path: string): LeafWalletRecoveryRecord {
  return JSON.parse(readFileSync(path, "utf8")) as LeafWalletRecoveryRecord;
}
