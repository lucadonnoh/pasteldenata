import { NextResponse } from "next/server";
import { getDemoReadiness } from "@/src/server/demo-readiness";
import {
  LocalDemoRequestError,
  assertLocalDemoRequest,
} from "@/src/server/local-demo-request";

export const runtime = "nodejs";

/**
 * Let the local UI render an honest preflight without exposing either Hedera
 * credential. Live signature validity is still checked by Hedera on use.
 */
export function GET(request: Request) {
  try {
    assertLocalDemoRequest(request);
    return NextResponse.json(getDemoReadiness(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Readiness check failed.";
    const status =
      error instanceof LocalDemoRequestError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
