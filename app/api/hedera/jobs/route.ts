import { NextResponse } from "next/server";
import type { AuctionResult, PrivatePlan } from "@/src/domain";
import { validateSettlement } from "@/src/payments";
import { startSettlementJob } from "@/src/server/settlement-jobs";

export const runtime = "nodejs";

/**
 * Start a Hedera settlement job. The browser sends only public data — the
 * normalized plan and auction results; the private intent and the 0G key
 * never reach this server. Live mode runs real reverse auctions on HCS; the
 * response returns immediately so the browser can watch the topics via
 * Mirror Node while the agents work. Demo endpoint — no auth, testnet only.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      plan?: PrivatePlan;
      auctions?: AuctionResult[];
      live?: boolean;
    };
    if (!body.plan?.planId || !Array.isArray(body.auctions)) {
      throw new Error("Expected { plan, auctions }.");
    }
    validateSettlement(body.plan, body.auctions);
    const job = startSettlementJob(
      body.plan,
      body.auctions,
      body.live !== false,
    );
    return NextResponse.json({ jobId: job.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
