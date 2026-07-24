import { createHash } from "node:crypto";
import { z } from "zod";
import { publicCatalogForPlanner } from "./catalog";
import {
  CATEGORIES,
  type PlanAllocation,
  type PlannerAttestation,
  type PrivatePlan,
} from "./domain";
import { parseBudgetCents } from "./money";
import { tomorrowInLisbon } from "./time";

const AllocationSchema = z.object({
  category: z.enum(CATEGORIES),
  maxBudgetCents: z.number().int().positive(),
  requirements: z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(/[,;]/)
            .map((item) => item.trim())
            .filter(Boolean)
        : value,
    z.array(z.string().min(1)).min(1).max(8),
  ),
  priority: z.number().int().min(1).max(5),
});

const ModelPlanSchema = z.object({
  occasionTitle: z.string().min(1).max(100),
  location: z.string().min(1).max(100),
  scheduledFor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  allocations: z.array(AllocationSchema).min(1).max(5),
});

interface ModelPlan {
  occasionTitle: string;
  location: string;
  scheduledFor: string;
  allocations: PlanAllocation[];
}

interface RouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  model?: string;
  provider?: string;
  provider_address?: string;
  tee_verified?: boolean;
  cost?: string | number;
  x_0g_trace?: {
    provider?: string;
    tee_verified?: boolean;
    billing?: {
      total_cost?: string;
    };
  };
}

export interface PlannerResult {
  plan: PrivatePlan;
  attestation: PlannerAttestation;
}

export interface PrivatePlanner {
  plan(intent: string, now?: Date): Promise<PlannerResult>;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function extractJson(content: string): unknown {
  const unfenced = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error("The private planner did not return a JSON plan.");
  }
  return JSON.parse(unfenced.slice(firstBrace, lastBrace + 1));
}

function enforcePlan(
  modelPlan: ModelPlan,
  totalBudgetCents: number,
  expectedDate: string,
  intent: string,
): PrivatePlan {
  const unique = new Set(modelPlan.allocations.map((item) => item.category));
  if (unique.size !== modelPlan.allocations.length) {
    throw new Error("The private planner allocated the same category twice.");
  }

  const allocated = modelPlan.allocations.reduce(
    (sum, allocation) => sum + allocation.maxBudgetCents,
    0,
  );
  if (allocated > totalBudgetCents) {
    throw new Error(
      `The private planner exceeded the hard budget by ${allocated - totalBudgetCents} cents.`,
    );
  }

  return {
    planId: stableId("plan", `${intent}|${expectedDate}|${totalBudgetCents}`),
    occasionTitle: modelPlan.occasionTitle,
    location: modelPlan.location,
    scheduledFor: expectedDate,
    currency: "USD",
    totalBudgetCents,
    allocations: modelPlan.allocations,
    unallocatedBudgetCents: totalBudgetCents - allocated,
  };
}

export class ZeroGPrivatePlanner implements PrivatePlanner {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://router-api.0g.ai/v1",
    private readonly model = "0gm-1.0-35b-a3b",
  ) {}

  async plan(intent: string, now = new Date()): Promise<PlannerResult> {
    const totalBudgetCents = parseBudgetCents(intent);
    const expectedDate = tomorrowInLisbon(now);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-0G-Provider-Trust-Mode": "private",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.15,
        max_tokens: 900,
        verify_tee: true,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are a confidential procurement planner running inside a TEE.",
              "Convert the user's private intent into category-scoped spending mandates.",
              "Use only categories present in the catalog.",
              "Choose a practical bundle, normally 2-4 categories.",
              "Never exceed the hard total budget.",
              "Leave a small unallocated contingency when practical.",
              "The scheduledFor date must equal the supplied target date.",
              "Return JSON only with: occasionTitle, location, scheduledFor, allocations.",
              "Each allocation has: category, maxBudgetCents, requirements, priority (1-5).",
              "Amounts are integer US cents.",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              privateIntent: intent,
              hardBudgetCents: totalBudgetCents,
              currency: "USD",
              targetDate: expectedDate,
              defaultLocation: "Lisbon",
              availableServices: publicCatalogForPlanner(),
            }),
          },
        ],
      }),
    });

    const raw = (await response.json()) as RouterResponse & {
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(
        `0G Router returned ${response.status}: ${raw.error?.message ?? "unknown error"}`,
      );
    }
    const teeVerified =
      raw.tee_verified === true || raw.x_0g_trace?.tee_verified === true;
    if (!teeVerified) {
      throw new Error("0G returned a response without successful TEE verification.");
    }

    const content = raw.choices?.[0]?.message?.content;
    if (!content) throw new Error("0G returned an empty planner response.");

    const modelPlan = ModelPlanSchema.parse(extractJson(content));
    const provider =
      raw.provider ?? raw.provider_address ?? raw.x_0g_trace?.provider;
    const costNeuron =
      raw.x_0g_trace?.billing?.total_cost ??
      (raw.cost === undefined ? undefined : String(raw.cost));

    return {
      plan: enforcePlan(
        modelPlan,
        totalBudgetCents,
        expectedDate,
        intent,
      ),
      attestation: {
        mode: "0g-private-tee",
        teeVerified: true,
        model: raw.model ?? this.model,
        ...(provider ? { provider } : {}),
        ...(costNeuron ? { costNeuron } : {}),
      },
    };
  }
}

export class MockPrivatePlanner implements PrivatePlanner {
  async plan(intent: string, now = new Date()): Promise<PlannerResult> {
    const totalBudgetCents = parseBudgetCents(intent);
    if (totalBudgetCents < 8000) {
      throw new Error("The mock date bundle needs a budget of at least $80.");
    }

    const targetDate = tomorrowInLisbon(now);
    const weights = [
      { category: "flowers" as const, weight: 0.16, priority: 3 },
      { category: "cinema" as const, weight: 0.18, priority: 4 },
      { category: "dinner" as const, weight: 0.59, priority: 5 },
    ];
    const allocations = weights.map(({ category, weight, priority }) => ({
      category,
      maxBudgetCents: Math.floor(totalBudgetCents * weight),
      requirements:
        category === "flowers"
          ? ["romantic", "local", "available tomorrow"]
          : category === "cinema"
            ? ["two seats", "evening", "central"]
            : ["dinner for two", "romantic", "central", "tomorrow evening"],
      priority,
    }));

    return {
      plan: enforcePlan(
        {
          occasionTitle: "A private date in Lisbon",
          location: "Lisbon",
          scheduledFor: targetDate,
          allocations,
        },
        totalBudgetCents,
        targetDate,
        intent,
      ),
      attestation: {
        mode: "local-mock",
        teeVerified: false,
        model: "deterministic-test-planner",
      },
    };
  }
}
