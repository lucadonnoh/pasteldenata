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

export interface PlannerAttestation {
  mode: "0g-private-tee" | "local-mock";
  teeVerified: boolean;
  provider?: string;
  model: string;
  costNeuron?: string;
}

export interface Seller {
  id: string;
  name: string;
  category: Category;
  offering: string;
  listPriceCents: number;
  reservePriceCents: number;
  quality: number;
  tags: string[];
  privateSalt: string;
}

/**
 * Deliberately excludes the user's full prompt, global budget, and category cap.
 * This is the entire view exposed to a mocked seller.
 */
export interface SellerAuctionView {
  auctionId: string;
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

export interface Bid {
  auctionId: string;
  sellerId: string;
  sellerName: string;
  offering: string;
  amountCents: number;
  quality: number;
  tags: string[];
  salt: string;
}

export interface BidCommitment {
  sellerId: string;
  commitment: string;
  reveal: () => Bid;
}

export interface AuctionResult {
  auctionId: string;
  category: Category;
  mandate: SpendMandate;
  commitments: string[];
  bids: Bid[];
  winner: Bid;
  score: number;
}

export interface PaymentReceipt {
  id: string;
  planId: string;
  mandateId: string;
  sellerId: string;
  sellerName: string;
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
