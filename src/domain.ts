export const CATEGORIES = [
  "flowers",
  "cinema",
  "dinner",
  "transport",
  "experience",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type City = "lisbon" | "milan" | "tokyo" | "mumbai" | "newyork";

export interface PlanAllocation {
  category: Category;
  maxBudgetCents: number;
  requirements: string[];
  priority: number;
}

export interface PrivatePlan {
  planId: string;
  occasionTitle: string;
  location: string;
  scheduledFor: string;
  currency: "USD";
  totalBudgetCents: number;
  allocations: PlanAllocation[];
  unallocatedBudgetCents: number;
}

export interface ZeroGRouterTrace {
  request_id: string;
  provider: string;
  billing?: {
    input_cost?: string | number;
    output_cost?: string | number;
    total_cost?: string | number;
  };
  tee_verified: true;
}

export interface IndependentTeeVerification {
  verified: true;
  method: "onchain-signer-eip191";
  chainId: 16661;
  rpcUrl: string;
  serviceContract: string;
  provider: string;
  chatId: string;
  serviceUrl: string;
  serviceModel: string;
  verifiability: "TeeML";
  signingAddress: string;
  recoveredAddress: string;
  signatureEndpoint: string;
  signedPayload: string;
  signature: string;
  messageHash: string;
  signatureVerified: true;
  signedRequestHash?: string;
  signedResponseHash?: string;
  providerType?: string;
  providerIdentity?: string;
  tlsCertFingerprint?: string;
}

export interface PlannerAttestation {
  mode: "0g-private-tee" | "local-mock";
  teeVerified: boolean;
  provider?: string;
  model: string;
  costNeuron?: string;
  requestId?: string;
  chatId?: string;
  routerTrace?: ZeroGRouterTrace;
  independentVerification?: IndependentTeeVerification;
  /** Deterministic post-inference policy repairs, shown for auditability. */
  localPolicyAdjustments?: string[];
}

export type InventoryAttributes = Record<
  string,
  string | number | boolean | string[]
>;

export interface SellerInventoryItem {
  id: string;
  offering: string;
  estimatedMarketPriceCents: number;
  floorPriceCents: number;
  quality: number;
  marketHeat: number;
  tags: string[];
  attributes: InventoryAttributes;
}

/**
 * Seller-chosen access policy for scarce listings. `one-per-human` requires
 * bidders to be backed by verified humans (World AgentKit) and collapses all
 * of one human's agents into a single allocation. `open` involves no
 * identity check at all — human gating is the seller's choice, not
 * marketplace-wide ceremony.
 */
export type HumanPolicy = "open" | "one-per-human";

export interface Seller {
  id: string;
  name: string;
  category: Category;
  city: City;
  privateSalt: string;
  humanPolicy?: HumanPolicy;
  inventory: SellerInventoryItem[];
}

/**
 * The planner and buyer subagents may inspect this listing. Seller floors,
 * demand settings, salts, and sold state are intentionally omitted.
 */
export interface PublicListing {
  id: string;
  sellerId: string;
  sellerName: string;
  city: City;
  category: Category;
  offering: string;
  estimatedMarketPriceCents: number;
  quality: number;
  tags: string[];
  attributes: InventoryAttributes;
}

export interface PaymentReceipt {
  id: string;
  planId: string;
  mandateId: string;
  sellerId: string;
  sellerName: string;
  listingId: string;
  offering: string;
  category: Category;
  amountCents: number;
  currency: "USD";
  status: "hedera-settled";
  /** Hedera transaction id of the atomic settlement transfer. */
  transactionId?: string;
  hashscanUrl?: string;
  /**
   * Isolated leaf-agent account that held exactly this mandate's cap and
   * nothing more.
   */
  escrowAccountId?: string;
  /** Serial of the HTS claim NFT delivered in the same atomic transaction. */
  claimNftSerial?: number;
  /**
   * Local mode-0600 recovery record for the isolated leaf wallet. This path
   * is intentionally local-only and never belongs in the public UI.
   */
  leafWalletRecoveryPath?: string;
  /** Per-listing HCS auction topic. */
  auctionTopicUrl?: string;
  /** Live auction stats: total on-chain bids and the price discovery range. */
  liveBids?: number;
  liveOpeningCents?: number;
  /** Contingency the root granted this agent on-chain mid-auction. */
  liveGrantedCents?: number;
}

export interface HederaSummary {
  network: "testnet";
  paymentTokenId: string;
  claimTokenId: string;
  buyerAccountId: string;
  /** Marketplace clearing account that funds leaf wallets. */
  clearingAccountId?: string;
}

export interface SettlementResult {
  receipts: PaymentReceipt[];
  hedera?: HederaSummary;
}

/**
 * Browser product state. The verified plan goes directly to the Hedera market
 * and only ledger-confirmed receipts are ever added.
 */
export interface PurchaseSessionResult {
  plan: PrivatePlan;
  attestation: PlannerAttestation;
  receipts: PaymentReceipt[];
  totalSpentCents: number;
  hedera?: HederaSummary;
}
