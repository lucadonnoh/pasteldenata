import type { Category, InventoryAttributes } from "../domain";
import type { StoredAccount } from "./infra";

/**
 * Public offer data a settlement leaf may evaluate. It deliberately contains
 * neither seller reserves nor any data from another buyer mandate.
 */
export interface HederaOffer {
  listingId: string;
  sellerId: string;
  sellerName: string;
  offering: string;
  amountCents: number;
  quality: number;
  tags: string[];
  attributes: InventoryAttributes;
}

/**
 * Everything a leaf agent is allowed to know. Deliberately excludes the
 * intent, the global budget, the other mandates, and every other agent wallet.
 */
export interface LeafMandate {
  auctionId: string;
  mandateId: string;
  planId: string;
  category: Category;
  maxAmountCents: number;
  requirements: string[];
}

/** A scarce item listed by a seller: bidding starts at the seller's floor. */
export interface ContestedListing {
  itemId: string;
  listingId: string;
  topicId: string;
  topicSubmitKey: string;
  sellerId: string;
  sellerAccountId: string;
  sellerName: string;
  offering: string;
  floorCents: number;
  quality: number;
  tags: string[];
  attributes: InventoryAttributes;
}

export interface AuthorizedLiveOffer {
  offer: Omit<HederaOffer, "amountCents">;
  sellerAccountId: string;
}

export interface LeafInit {
  type: "MANDATE";
  mandate: LeafMandate;
  wallet: StoredAccount;
  paymentTokenId: string;
  claimTokenId: string;
  auctionTopicId: string;
  topicSubmitKey: string;
  clearingAccountId: string;
  /** Present in live mode: the leaf reads authenticated offers from its topic. */
  live?: {
    mirrorBaseUrl: string;
    authorizedOffers: AuthorizedLiveOffer[];
  };
  /** Present in market mode: ascending auctions over scarce listings. */
  contested?: { mirrorBaseUrl: string; listings: ContestedListing[] };
  /** Display label for multi-buyer runs, e.g. the buyer persona name. */
  buyerLabel?: string;
}

export type ParentToLeaf =
  | LeafInit
  | { type: "OFFERS"; offers: HederaOffer[] }
  | { type: "PREPARED"; sellerAccountId: string; claimNftSerial: number }
  /** Market mode: the item was already sold to another agent. */
  | { type: "PREPARE_REJECTED" }
  | { type: "SIGNED"; txBytesB64: string }
  /** Market mode: clearing submitted the fully authorized atomic swap. */
  | { type: "SETTLED"; txBytesB64: string; transactionId: string }
  | { type: "SETTLEMENT_RECORDED" }
  /** grantedCents = 0 means the root refused the top-up. */
  | { type: "BUDGET_GRANTED"; grantedCents: number };

export interface LiveStats {
  bids: number;
  openingCents: number;
  closingCents: number;
  grantedCents: number;
}

export interface LeafResult {
  listingId: string;
  offering: string;
  sellerId: string;
  sellerName: string;
  amountCents: number;
  transactionId: string;
  leafAccountId: string;
  claimNftSerial: number;
  auctionTopicId: string;
  marketItemId?: string;
  liveStats?: LiveStats;
  /** Market mode: the agent was outbid everywhere it could afford. */
  lost?: boolean;
  /** Market mode: contingency granted on-chain during the bid war. */
  grantedCents?: number;
}

export type LeafToParent =
  | { type: "RFQ" }
  | {
      type: "PREPARE";
      sellerId: string;
      listingId: string;
      amountCents: number;
    }
  | { type: "SIGN_REQUEST"; sellerId: string; txBytesB64: string }
  /** Live mode: ask the root for contingency budget when priced out. */
  | { type: "BUDGET_REQUEST"; neededCents: number }
  | { type: "SETTLEMENT_CONFIRMED"; result: LeafResult }
  | { type: "DONE"; result: LeafResult }
  | { type: "ERROR"; message: string };
