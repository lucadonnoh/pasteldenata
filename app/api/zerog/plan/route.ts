import { NextResponse } from "next/server";
import { z } from "zod";
import { UnknownCityError } from "@/src/catalog";
import {
  requireVerifiedPrivateTee,
  VerifiedUnknownCityError,
  ZeroGPrivatePlanner,
} from "@/src/planner";
import {
  DemoRateLimitError,
  consumeHostedDemoCapacity,
} from "@/src/server/demo-rate-limit";
import {
  LocalDemoRequestError,
  assertLocalDemoRequest,
} from "@/src/server/local-demo-request";

export const runtime = "nodejs";
export const maxDuration = 60;

const HostedPlanRequest = z
  .object({
    intent: z.string().trim().min(3).max(1200),
  })
  .strict();

function hostedKey(): string {
  if (
    process.env.HOSTED_DEMO_MODE !== "true" ||
    process.env.ZEROG_SERVER_DEMO !== "true"
  ) {
    throw new LocalDemoRequestError(
      "The hosted 0G demo route is not enabled.",
    );
  }
  const key = process.env.ZEROG_KEY?.trim();
  if (!key) {
    throw new Error("The hosted 0G demo key is not configured.");
  }
  return key;
}

/**
 * Hosted hackathon convenience mode. The 0G key never enters the browser, but
 * the plaintext intent necessarily crosses the Railway coordinator before it
 * reaches the 0G private TeeML route. The response is accepted only after the
 * same Router and independent signer checks used by the local BYOK flow.
 */
export async function POST(request: Request) {
  try {
    assertLocalDemoRequest(request, { mutating: true });
    consumeHostedDemoCapacity(request, "zerog-plan");
    const { intent } = HostedPlanRequest.parse(await request.json());
    const planned = await new ZeroGPrivatePlanner(hostedKey()).plan(intent);
    requireVerifiedPrivateTee(planned.attestation);
    return NextResponse.json(planned, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof VerifiedUnknownCityError) {
      return NextResponse.json(
        {
          code: "UNKNOWN_CITY",
          error: error.message,
          location: error.location,
          available: error.available,
          attestation: error.attestation,
        },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof UnknownCityError) {
      return NextResponse.json(
        {
          code: "UNKNOWN_CITY",
          error: error.message,
          location: error.location,
          available: error.available,
        },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }

    const message =
      error instanceof Error ? error.message : "Private planning failed.";
    const status =
      error instanceof LocalDemoRequestError ||
      error instanceof DemoRateLimitError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 502;
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (error instanceof DemoRateLimitError) {
      headers["Retry-After"] = String(error.retryAfterSeconds);
    }
    return NextResponse.json({ error: message }, { status, headers });
  }
}
