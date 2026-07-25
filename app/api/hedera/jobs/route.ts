import { NextResponse } from "next/server";
import {
  LocalDemoRequestError,
  assertLocalDemoRequest,
} from "@/src/server/local-demo-request";
import {
  DemoRateLimitError,
  consumeHostedDemoCapacity,
} from "@/src/server/demo-rate-limit";
import { proveHostedWorldIdentity } from "@/src/server/hosted-world-identity";
import { startSettlementJob } from "@/src/server/settlement-jobs";
import { parseSettlementRequest } from "@/src/server/settlement-request";
import { consumeWorldIdentityProof } from "@/src/server/world-identity-auth";
import { createHumanResolver } from "@/src/server/world-gateway";

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
    const hostedIdentityAgent = await proveHostedWorldIdentity(
      body.plan.planId,
      body.hostedWorldIdentity ?? { mode: "verified" },
    );
    const identityAgent =
      hostedIdentityAgent ??
      (body.identityProof
        ? await consumeWorldIdentityProof(body.identityProof, body.plan.planId)
        : undefined);
    if (
      hostedIdentityAgent &&
      body.hostedWorldIdentity?.mode !== "visitor"
    ) {
      const humanId = await (
        await createHumanResolver()
      ).lookupHuman(hostedIdentityAgent);
      if (!humanId) {
        throw new Error(
          "The shared hosted identity is not registered in the World AgentBook.",
        );
      }
    }
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
