import { z } from "zod";
import { sellersForLocation } from "../catalog";
import {
  CATEGORIES,
  type AuctionResult,
  type PrivatePlan,
} from "../domain";
import type { SettlementMode } from "./settlement-jobs";

const identifier = z.string().trim().min(1).max(160);
const shortText = z.string().trim().min(1).max(300);
const cents = z.number().int().safe().positive().max(1_000_000);
const category = z.enum(CATEGORIES);

const AllocationSchema = z
  .object({
    category,
    maxBudgetCents: cents,
    requirements: z.array(shortText).max(20),
    priority: z.number().int().min(1).max(5),
  })
  .passthrough();

const PlanSchema = z
  .object({
    planId: identifier,
    occasionTitle: shortText,
    location: shortText,
    scheduledFor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    currency: z.literal("USD"),
    totalBudgetCents: cents,
    allocations: z.array(AllocationSchema).min(1).max(CATEGORIES.length),
    unallocatedBudgetCents: z.number().int().safe().nonnegative().max(1_000_000),
  })
  .passthrough()
  .superRefine((plan, context) => {
    const categories = new Set(plan.allocations.map((item) => item.category));
    if (categories.size !== plan.allocations.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Plan allocations must use unique categories.",
      });
    }
    const allocated = plan.allocations.reduce(
      (sum, item) => sum + item.maxBudgetCents,
      0,
    );
    if (
      allocated > plan.totalBudgetCents ||
      allocated + plan.unallocatedBudgetCents !== plan.totalBudgetCents
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Plan allocations and contingency must equal the total budget.",
      });
    }
  });

const BuyerSubagentSchema = z
  .object({
    id: identifier,
    category,
    mandateId: identifier,
    requirements: z.array(shortText).max(20),
    priority: z.number().int().min(1).max(5),
    strategy: z.literal("fit-adjusted-private-valuation"),
  })
  .passthrough();

const MandateSchema = z
  .object({
    id: identifier,
    planId: identifier,
    category,
    maxAmountCents: cents,
    currency: z.literal("USD"),
    expiresAt: z.string().datetime(),
  })
  .passthrough();

const WinnerSchema = z
  .object({
    auctionId: identifier,
    listingId: identifier,
    sellerId: identifier,
    sellerName: shortText,
    offering: shortText,
    amountCents: cents,
    quality: z.number().finite().min(0).max(100),
    tags: z.array(shortText).max(30),
    attributes: z.record(z.unknown()),
  })
  .passthrough();

const AuctionSchema = z
  .object({
    auctionId: identifier,
    category,
    buyerSubagent: BuyerSubagentSchema,
    mandate: MandateSchema,
    listingAuctions: z.array(z.unknown()).max(100),
    winner: WinnerSchema,
    score: z.number().finite(),
  })
  .passthrough();

const SettlementRequestSchema = z
  .object({
    plan: PlanSchema,
    auctions: z.array(AuctionSchema).min(1).max(CATEGORIES.length),
    mode: z.enum(["live", "market"]).default("market"),
    worldDemo: z.enum(["scalper"]).optional(),
    identityAgent: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  })
  .superRefine(({ plan, auctions }, context) => {
    const roster = sellersForLocation(plan.location);
    if (auctions.length !== plan.allocations.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Every allocation must have exactly one auction.",
      });
      return;
    }

    const allocations = new Map(
      plan.allocations.map((item) => [item.category, item]),
    );
    const auctionCategories = new Set<string>();
    const mandateIds = new Set<string>();

    for (const auction of auctions) {
      const allocation = allocations.get(auction.category);
      if (
        !allocation ||
        auctionCategories.has(auction.category) ||
        mandateIds.has(auction.mandate.id) ||
        auction.mandate.planId !== plan.planId ||
        auction.mandate.category !== auction.category ||
        auction.mandate.maxAmountCents !== allocation.maxBudgetCents ||
        auction.buyerSubagent.category !== auction.category ||
        auction.buyerSubagent.mandateId !== auction.mandate.id
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Auction ${auction.auctionId} does not match its scoped allocation.`,
        });
      }
      auctionCategories.add(auction.category);
      mandateIds.add(auction.mandate.id);

      const seller = roster.find(
        (candidate) =>
          candidate.id === auction.winner.sellerId &&
          candidate.category === auction.category,
      );
      const listing = seller?.inventory.find(
        (candidate) => candidate.id === auction.winner.listingId,
      );
      if (!seller || !listing) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Auction ${auction.auctionId} references unknown mock inventory.`,
        });
      }
    }
  });

export interface ParsedSettlementRequest {
  plan: PrivatePlan;
  auctions: AuctionResult[];
  mode: SettlementMode;
  worldDemo?: "scalper";
  identityAgent?: string;
}

export function parseSettlementRequest(input: unknown): ParsedSettlementRequest {
  const result = SettlementRequestSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid settlement payload: ${result.error.issues[0]?.message ?? "schema mismatch"}`,
    );
  }
  return result.data as ParsedSettlementRequest;
}
