import { NextResponse } from "next/server";
import { MOCK_SELLERS } from "@/src/catalog";
import type { AuctionResult, PrivatePlan } from "@/src/domain";
import { connectHedera } from "@/src/hedera/client";
import { ensureInfra } from "@/src/hedera/infra";
import { settleWithSwarm } from "@/src/hedera/swarm";
import { validateSettlement } from "@/src/payments";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Settle an already-planned, already-auctioned bundle for real on the Hedera
 * testnet. The browser sends only public data: the normalized plan and the
 * auction results. The private intent and the 0G key never reach this
 * server; the Hedera operator key never reaches the browser. Demo endpoint —
 * no auth, testnet only.
 */
export async function POST(request: Request) {
  let plan: PrivatePlan;
  let auctions: AuctionResult[];
  try {
    const body = (await request.json()) as {
      plan?: PrivatePlan;
      auctions?: AuctionResult[];
    };
    if (!body.plan?.planId || !Array.isArray(body.auctions)) {
      throw new Error("Expected { plan, auctions }.");
    }
    plan = body.plan;
    auctions = body.auctions;
    // Same deterministic policy gate the settlers use; fail fast with a 400
    // instead of touching the ledger.
    validateSettlement(plan, auctions);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const ctx = connectHedera();
  try {
    const infra = await ensureInfra(ctx, MOCK_SELLERS);
    const settlement = await settleWithSwarm(plan, auctions, { ...ctx, infra });
    return NextResponse.json(settlement);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Settlement failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    ctx.client.close();
  }
}
