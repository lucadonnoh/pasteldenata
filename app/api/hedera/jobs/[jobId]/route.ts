import { NextResponse } from "next/server";
import { getSettlementJob } from "@/src/server/settlement-jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getSettlementJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }
  return NextResponse.json({
    status: job.status,
    live: job.live,
    agents: job.agents,
    auctions: job.auctions,
    settledCategories: job.settledCategories,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
}
