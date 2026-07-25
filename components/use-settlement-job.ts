"use client";

import { useEffect, useRef, useState } from "react";

import type { SettlementResult } from "@/src/orchestrator";
import { usePurchaseSession } from "@/components/purchase-session";

export interface LiveSellerBid {
  sellerId: string;
  sellerName: string;
  offering: string;
  amountCents: number;
  sequenceNumber: number;
}

export interface LiveAuctionView {
  /** Real leaf wallets, as the swarm creates them. */
  agents: Array<{ category: string; accountId: string }>;
  /** Real HCS topics, one per auction. */
  auctions: Array<{ category: string; auctionId: string; topicId: string }>;
  /** Real seller bids read straight from Mirror Node, oldest first. */
  bidsByCategory: Record<string, LiveSellerBid[]>;
  settledCategories: string[];
  active: boolean;
  done: boolean;
}

const MIRROR_BASE = "https://testnet.mirrornode.hedera.com";
const JOB_POLL_MS = 2000;
const MIRROR_POLL_MS = 2500;

interface JobSnapshot {
  status: "running" | "done" | "failed";
  agents?: LiveAuctionView["agents"];
  auctions?: LiveAuctionView["auctions"];
  settledCategories?: string[];
  result?: SettlementResult;
  error?: string;
}

/**
 * Drives a running settlement job: polls the job for real agent wallets and
 * auction topics, streams the actual seller bids from Mirror Node (the
 * browser reads the public ledger directly), and merges the receipts into
 * the session when the swarm finishes.
 */
export function useSettlementJob(): LiveAuctionView | undefined {
  const {
    result,
    setResult,
    settlement,
    setSettlement,
    setSettlementError,
    jobId,
  } = usePurchaseSession();
  const resultRef = useRef(result);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  const [agents, setAgents] = useState<LiveAuctionView["agents"]>([]);
  const [auctions, setAuctions] = useState<LiveAuctionView["auctions"]>([]);
  const [settledCategories, setSettledCategories] = useState<string[]>([]);
  const [bidsByCategory, setBidsByCategory] = useState<
    Record<string, LiveSellerBid[]>
  >({});

  useEffect(() => {
    if (!jobId || settlement !== "pending") return;
    let cancelled = false;

    const tick = async () => {
      try {
        const response = await fetch(`/api/hedera/jobs/${jobId}`);
        if (!response.ok) return;
        const job = (await response.json()) as JobSnapshot;
        if (cancelled) return;
        setAgents(job.agents ?? []);
        setAuctions(job.auctions ?? []);
        setSettledCategories(job.settledCategories ?? []);

        if (job.status === "done" && job.result) {
          const purchase = resultRef.current;
          if (purchase) {
            const receipts = job.result.receipts;
            const totalSpentCents = receipts.reduce(
              (sum, receipt) => sum + receipt.amountCents,
              0,
            );
            setResult({
              ...purchase,
              receipts,
              totalSpentCents,
              ...(job.result.hedera ? { hedera: job.result.hedera } : {}),
            });
          }
          setSettlement("settled");
        } else if (job.status === "failed") {
          setSettlementError(job.error ?? "Settlement failed.");
          setSettlement("failed");
        }
      } catch {
        // Transient network error; the next tick retries.
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), JOB_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, settlement, setResult, setSettlement, setSettlementError]);

  const topicsKey = auctions
    .map((auction) => `${auction.category}:${auction.topicId}`)
    .join(",");

  useEffect(() => {
    if (!topicsKey || settlement !== "pending") return;
    let cancelled = false;

    const tick = async () => {
      const next: Record<string, LiveSellerBid[]> = {};
      await Promise.all(
        auctions.map(async ({ category, auctionId, topicId }) => {
          try {
            const response = await fetch(
              `${MIRROR_BASE}/api/v1/topics/${topicId}/messages?limit=100&order=asc`,
            );
            if (!response.ok) return;
            const data = (await response.json()) as {
              messages?: Array<{ message: string; sequence_number: number }>;
            };
            const bids: LiveSellerBid[] = [];
            for (const item of data.messages ?? []) {
              try {
                const parsed = JSON.parse(atob(item.message)) as Record<
                  string,
                  unknown
                >;
                if (parsed.type !== "BID" || parsed.auctionId !== auctionId) {
                  continue;
                }
                bids.push({
                  sellerId: String(parsed.sellerId),
                  sellerName: String(parsed.sellerName),
                  offering: String(parsed.offering),
                  amountCents: Number(parsed.amountCents),
                  sequenceNumber: item.sequence_number,
                });
              } catch {
                // Not a JSON bid message; skip.
              }
            }
            next[category] = bids;
          } catch {
            // Mirror hiccup; keep the previous view for this topic.
          }
        }),
      );
      if (!cancelled && Object.keys(next).length > 0) {
        setBidsByCategory((previous) => ({ ...previous, ...next }));
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), MIRROR_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicsKey, settlement]);

  if (!jobId || settlement === "idle" || settlement === "failed") {
    return undefined;
  }
  return {
    agents,
    auctions,
    bidsByCategory,
    settledCategories,
    active: settlement === "pending",
    done: settlement === "settled",
  };
}
