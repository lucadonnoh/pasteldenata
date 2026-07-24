export const CATEGORIES = [
  "flowers",
  "cinema",
  "dinner",
  "transport",
  "experience",
] as const;

export type Category = (typeof CATEGORIES)[number];

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
  method: "onchain-signer-eip191-response-bound";
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
  responseHashVerified: true;
  responseHashMethod:
    | "raw-router-response"
    | "raw-without-router-trace"
    | "json-without-router-trace"
    | "jcs-without-router-trace";
  computedResponseHash: string;
  excludedResponseFields: [] | ["x_0g_trace"];
  signedRequestHash?: string;
  signedResponseHash: string;
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

export interface Seller {
  id: string;
  name: string;
  category: Category;
  privateSalt: string;
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
  category: Category;
  offering: string;
  estimatedMarketPriceCents: number;
  quality: number;
  tags: string[];
  attributes: InventoryAttributes;
}

/**
 * This is the entire request exposed to a mocked seller. It deliberately
 * excludes the original intent, global budget, category cap, and private
 * buyer valuation.
 */
export interface SellerAuctionView {
  auctionId: string;
  listingId: string;
  category: Category;
  location: string;
  scheduledFor: string;
  requirements: string[];
}

export interface SpendMandate {
  id: string;
  planId: string;
  category: Category;
  maxAmountCents: number;
  currency: "USD";
  expiresAt: string;
}

export interface BuyerSubagentTrace {
  id: string;
  category: Category;
  mandateId: string;
  requirements: string[];
  priority: number;
  strategy: "fit-adjusted-private-valuation";
}

export type AuctionParticipantKind =
  | "allocation-buyer-subagent"
  | "mock-rival";

/**
 * Debug valuations are included only to make the local hackathon simulation
 * auditable. A real English auction exposes bids and dropout points, not caps.
 */
export interface EnglishAuctionParticipantTrace {
  bidderId: string;
  bidderKind: AuctionParticipantKind;
  debugMaxBidCents: number;
}

export interface EnglishAuctionStep {
  sequence: number;
  askingPriceCents: number;
  activeBidderIds: string[];
  droppedBidderIds: string[];
  leadingBidderId: string | null;
}

export type ListingAuctionStatus = "won" | "lost" | "floor-not-met";

export interface ListingEnglishAuction {
  auctionId: string;
  listing: PublicListing;
  listingScore: number;
  status: ListingAuctionStatus;
  buyerSubagentId: string;
  buyerMaxBidCents: number;
  debugSellerFloorPriceCents: number;
  minimumIncrementCents: number;
  participants: EnglishAuctionParticipantTrace[];
  steps: EnglishAuctionStep[];
  winningBidderId: string | null;
  clearingPriceCents: number | null;
}

export interface AuctionWin {
  auctionId: string;
  listingId: string;
  sellerId: string;
  sellerName: string;
  offering: string;
  amountCents: number;
  quality: number;
  tags: string[];
  attributes: InventoryAttributes;
}

export interface AuctionResult {
  auctionId: string;
  category: Category;
  buyerSubagent: BuyerSubagentTrace;
  mandate: SpendMandate;
  listingAuctions: ListingEnglishAuction[];
  winner: AuctionWin;
  score: number;
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
  status: "simulated-settled";
}

export interface DemoResult {
  plan: PrivatePlan;
  attestation: PlannerAttestation;
  auctions: AuctionResult[];
  receipts: PaymentReceipt[];
  totalSpentCents: number;
}
