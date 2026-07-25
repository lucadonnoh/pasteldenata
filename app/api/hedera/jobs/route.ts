import { NextResponse } from "next/server";
import {
  LocalDemoRequestError,
  assertLocalDemoRequest,
} from "@/src/server/local-demo-request";
import {
  DemoRateLimitError,
  consumeHostedDemoCapacity,
} from "@/src/server/demo-rate-limit";
import {
  SettlementJobBusyError,
  startSettlementJob,
} from "@/src/server/settlement-jobs";
import { parseSettlementRequest } from "@/src/server/settlement-request";
import { consumeWorldIdentityProof } from "@/src/server/world-identity-auth";

export const runtime = "nodejs";

/**
 * Start a Hedera testnet job. In local BYOK mode, only the verified derived
 * plan reaches this coordinator. Hosted demo mode also runs planning here, but
 * both modes submit exactly the same verified plan to the market.
 */
export async function POST(request: Request) {
  try {
    assertLocalDemoRequest(request, { mutating: true });
    consumeHostedDemoCapacity(request, "hedera-settlement");
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
        : error instanceof DemoRateLimitError
          ? error.status
        : error instanceof SettlementJobBusyError
          ? error.status
          : 400;
    return NextResponse.json(
      { error: message },
      {
        status,
        ...(error instanceof DemoRateLimitError
          ? {
              headers: {
                "Retry-After": String(error.retryAfterSeconds),
              },
            }
          : {}),
      },
    );
  }
}
