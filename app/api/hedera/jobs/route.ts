import { NextResponse } from "next/server";
import {
  LocalDemoRequestError,
  assertLocalDemoRequest,
} from "@/src/server/local-demo-request";
import {
  SettlementJobBusyError,
  startSettlementJob,
} from "@/src/server/settlement-jobs";
import { parseSettlementRequest } from "@/src/server/settlement-request";
import { consumeWorldIdentityProof } from "@/src/server/world-identity-auth";

export const runtime = "nodejs";

/**
 * Start a local Hedera testnet job. The original prompt and 0G key stay in
 * the browser, while only the verified derived plan is sent to this trusted
 * local coordinator. It owns the operator key, creates the real HCS auctions,
 * and funds the trusted child agents.
 */
export async function POST(request: Request) {
  try {
    assertLocalDemoRequest(request, { mutating: true });
    const body = parseSettlementRequest(await request.json());
    const identityAgent = body.identityProof
      ? await consumeWorldIdentityProof(body.identityProof, body.plan.planId)
      : undefined;
    const job = await startSettlementJob(
      body.plan,
      {
        scalperMode: body.worldDemo === "scalper",
        ...(identityAgent ? { identityAgent } : {}),
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
