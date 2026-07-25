import { NextResponse } from "next/server";
import { z } from "zod";
import {
  LocalDemoRequestError,
  assertLocalDemoRequest,
} from "@/src/server/local-demo-request";
import { createWorldIdentityChallenge } from "@/src/server/world-identity-auth";

export const runtime = "nodejs";

const ChallengeRequest = z.object({
  identityAgent: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  planId: z.string().trim().min(1).max(160),
});

export async function POST(request: Request) {
  try {
    assertLocalDemoRequest(request, { mutating: true });
    const input = ChallengeRequest.parse(await request.json());
    return NextResponse.json(
      createWorldIdentityChallenge(input.identityAgent, input.planId),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid challenge request.";
    const status =
      error instanceof LocalDemoRequestError ? error.status : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
