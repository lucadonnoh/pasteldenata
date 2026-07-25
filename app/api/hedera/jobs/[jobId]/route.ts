import { NextResponse } from "next/server";
import { getSettlementJob } from "@/src/server/settlement-jobs";
import {
  LocalDemoRequestError,
  assertLocalDemoRequest,
} from "@/src/server/local-demo-request";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    assertLocalDemoRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Forbidden.";
    const status =
      error instanceof LocalDemoRequestError ? error.status : 403;
    return NextResponse.json({ error: message }, { status });
  }
  const { jobId } = await params;
  const job = getSettlementJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }
  return NextResponse.json({
    status: job.status,
    mode: job.mode,
    agents: job.agents,
    auctions: job.auctions,
    listings: job.listings,
    rivals: job.rivals,
    settledCategories: job.settledCategories,
    lostCategories: job.lostCategories,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
}
