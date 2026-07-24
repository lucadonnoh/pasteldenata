import { NextResponse } from "next/server";
import { z } from "zod";

import { organizePrivatePurchase } from "@/src/orchestrator";
import {
  MockPrivatePlanner,
  ZeroGPrivatePlanner,
  type PrivatePlanner,
} from "@/src/planner";

export const runtime = "nodejs";

const RequestSchema = z.object({
  intent: z.string().trim().min(3).max(1200),
});

function createPlanner(): PrivatePlanner {
  const useMock =
    process.env.DEMO_MODE === "true" ||
    (!process.env.ZEROG_KEY && process.env.NODE_ENV !== "production");

  if (useMock) {
    return new MockPrivatePlanner();
  }

  const key = process.env.ZEROG_KEY;
  if (!key) {
    throw new Error(
      "ZEROG_KEY is missing. Configure it or enable DEMO_MODE.",
    );
  }

  return new ZeroGPrivatePlanner(
    key,
    process.env.ZEROG_BASE_URL,
    process.env.ZEROG_MODEL,
  );
}

export async function POST(request: Request) {
  try {
    const { intent } = RequestSchema.parse(await request.json());
    const result = await organizePrivatePurchase(createPlanner(), intent);

    return NextResponse.json({
      status: "accepted",
      planId: result.plan.planId,
      planner: result.attestation.mode,
      teeVerified: result.attestation.teeVerified,
      auctions: result.auctions.length,
      simulatedReceipts: result.receipts.length,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to process the intent.";

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
