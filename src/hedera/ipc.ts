import type { Bid, Category } from "../domain.js";
import type { StoredAccount } from "./infra.js";

/**
 * Everything a leaf agent is allowed to know. Deliberately excludes the
 * intent, the global budget, the other mandates, and every other agent's
 * wallet. Compromising one leaf reveals one compartment.
 */
export interface LeafMandate {
  auctionId: string;
  category: Category;
  maxAmountCents: number;
  requirements: string[];
}

export interface LeafInit {
  type: "MANDATE";
  mandate: LeafMandate;
  wallet: StoredAccount;
  paymentTokenId: string;
  claimTokenId: string;
  auctionTopicId: string;
  clearingAccountId: string;
  /** Present in live mode: the leaf reads competing bids from its topic. */
  live?: { mirrorBaseUrl: string };
}

export type ParentToLeaf =
  | LeafInit
  | {
      type: "BIDS";
      commitments: Array<{ sellerId: string; commitment: string }>;
      reveals: Bid[];
    }
  | { type: "PREPARED"; sellerAccountId: string; claimNftSerial: number }
  | { type: "SIGNED"; txBytesB64: string }
  /** grantedCents = 0 means the root refused the top-up. */
  | { type: "BUDGET_GRANTED"; grantedCents: number };

export interface LiveStats {
  bids: number;
  openingCents: number;
  closingCents: number;
  grantedCents: number;
}

export interface LeafResult {
  sellerId: string;
  sellerName: string;
  amountCents: number;
  transactionId: string;
  leafAccountId: string;
  claimNftSerial: number;
  auctionTopicId: string;
  liveStats?: LiveStats;
}

export type LeafToParent =
  | { type: "RFQ" }
  | { type: "PREPARE"; sellerId: string }
  | { type: "SIGN_REQUEST"; sellerId: string; txBytesB64: string }
  /** Live mode: ask the root for contingency budget when priced out. */
  | { type: "BUDGET_REQUEST"; neededCents: number }
  | { type: "DONE"; result: LeafResult }
  | { type: "ERROR"; message: string };
