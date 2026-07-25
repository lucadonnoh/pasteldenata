import { NextResponse } from "next/server";
import { validateSettlement } from "@/src/payments";
import {
  LocalDemoRequestError,
  assertLocalDemoRequest,
} from "@/src/server/local-demo-request";
import {
  SettlementJobBusyError,
  startSettlementJob,
} from "@/src/server/settlement-jobs";
import { parseSettlementRequest } from "@/src/server/settlement-request";

export const runtime = "nodejs";

/**
 * Start a local Hedera testnet job. The original prompt and 0G key stay in
 * the browser, while the derived plan and mock auction trace are deliberately
 * sent to this trusted local coordinator. It owns the operator key and funds
 * the trusted child agents.
 */
export async function POST(request: Request) {
  try {
    assertLocalDemoRequest(request, { mutating: true });
    const body = parseSettlementRequest(await request.json());
    validateSettlement(body.plan, body.auctions);
    const job = startSettlementJob(
      body.plan,
      body.auctions,
      body.mode,
      {
        scalperMode: body.worldDemo === "scalper",
        ...(body.identityAgent ? { identityAgent: body.identityAgent } : {}),
      },
    );
    return NextResponse.json({ jobId: job.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    const status =
      error instanceof LocalDemoRequestError
        ? error.status
        : error instanceof SettlementJobBusyError
          ? error.status
          : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
