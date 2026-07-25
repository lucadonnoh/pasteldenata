import { z } from "zod";
import { sellersForLocation } from "../catalog";
import { CATEGORIES, type PrivatePlan } from "../domain";

const identifier = z.string().trim().min(1).max(160);
const shortText = z.string().trim().min(1).max(300);
const cents = z.number().int().safe().positive().max(1_000_000);
const category = z.enum(CATEGORIES);
const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const AllocationSchema = z
  .object({
    category,
    maxBudgetCents: cents,
    requirements: z.array(shortText).max(20),
    priority: z.number().int().min(1).max(5),
  })
  .strict();

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
  .strict()
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

    let roster;
    try {
      roster = sellersForLocation(plan.location);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `No live Hedera seller market exists in ${plan.location}.`,
      });
      return;
    }
    for (const allocation of plan.allocations) {
      if (
        !roster.some(
          (seller) =>
            seller.category === allocation.category &&
            seller.inventory.length > 0,
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `No live seller inventory exists for ${allocation.category}.`,
        });
      }
    }
  });

const SettlementRequestSchema = z
  .object({
    plan: PlanSchema,
    worldDemo: z.enum(["scalper"]).optional(),
    identityProof: z
      .object({
        identityAgent: evmAddress,
        challengeId: z.string().uuid(),
        signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface ParsedSettlementRequest {
  plan: PrivatePlan;
  worldDemo?: "scalper";
  identityProof?: {
    identityAgent: `0x${string}`;
    challengeId: string;
    signature: `0x${string}`;
  };
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
