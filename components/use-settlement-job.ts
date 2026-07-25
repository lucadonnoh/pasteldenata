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

export interface MarketBid {
  bidder: string;
  amountCents: number;
  sequenceNumber: number;
  /** True when the bidder is one of the user's own agents. */
  yours: boolean;
}

export interface MarketListingView {
  itemId: string;
  topicId: string;
  category: string;
  sellerId: string;
  sellerName: string;
  offering: string;
  floorCents: number;
  sold: boolean;
}

export interface LiveAuctionView {
  mode: "live" | "market";
  /** Real leaf wallets, as the coordinators create them. */
  agents: Array<{ category: string; accountId: string; buyerName: string }>;
  /** Live mode: one HCS topic per category auction. */
  auctions: Array<{ category: string; auctionId: string; topicId: string }>;
  /** Live mode: real seller bids per category. */
  bidsByCategory: Record<string, LiveSellerBid[]>;
  /** Market mode: scarce listings and the ascending bids on each. */
  listings: MarketListingView[];
  bidsByItem: Record<string, MarketBid[]>;
  rivals: string[];
  settledCategories: string[];
  lostCategories: string[];
  active: boolean;
  done: boolean;
}

const MIRROR_BASE = "https://testnet.mirrornode.hedera.com";
const JOB_POLL_MS = 2000;
const MIRROR_POLL_MS = 2500;
const USER_BUYER_NAME = "You";

interface JobSnapshot {
  status: "running" | "done" | "failed";
  mode?: "live" | "market";
  agents?: LiveAuctionView["agents"];
  auctions?: LiveAuctionView["auctions"];
  listings?: MarketListingView[];
  rivals?: string[];
  settledCategories?: string[];
  lostCategories?: string[];
  result?: SettlementResult;
  error?: string;
}

/**
 * Drives a running settlement job: polls the job for real agent wallets,
 * topics, and listings, streams the actual bids from Mirror Node (the
 * browser reads the public ledger directly), and merges the receipts into
 * the session when the coordinator finishes.
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

  const [mode, setMode] = useState<"live" | "market">("market");
  const [agents, setAgents] = useState<LiveAuctionView["agents"]>([]);
  const [auctions, setAuctions] = useState<LiveAuctionView["auctions"]>([]);
  const [listings, setListings] = useState<MarketListingView[]>([]);
  const [rivals, setRivals] = useState<string[]>([]);
  const [settledCategories, setSettledCategories] = useState<string[]>([]);
  const [lostCategories, setLostCategories] = useState<string[]>([]);
  const [bidsByCategory, setBidsByCategory] = useState<
    Record<string, LiveSellerBid[]>
  >({});
  const [bidsByItem, setBidsByItem] = useState<Record<string, MarketBid[]>>(
    {},
  );

  useEffect(() => {
    if (!jobId || settlement !== "pending") return;
    let cancelled = false;

    const tick = async () => {
      try {
        const response = await fetch(`/api/hedera/jobs/${jobId}`);
        if (!response.ok) return;
        const job = (await response.json()) as JobSnapshot;
        if (cancelled) return;
        if (job.mode) setMode(job.mode);
        setAgents(job.agents ?? []);
        setAuctions(job.auctions ?? []);
        setListings(job.listings ?? []);
        setRivals(job.rivals ?? []);
        setSettledCategories(job.settledCategories ?? []);
        setLostCategories(job.lostCategories ?? []);

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

  const yourAgentIds = agents
    .filter((agent) => agent.buyerName === USER_BUYER_NAME)
    .map((agent) => agent.accountId)
    .join(",");
  const topicsKey =
    mode === "market"
      ? listings.map((listing) => `${listing.itemId}:${listing.topicId}`).join(",")
      : auctions
          .map((auction) => `${auction.category}:${auction.topicId}`)
          .join(",");

  useEffect(() => {
    if (!topicsKey || settlement !== "pending") return;
    let cancelled = false;
    const mine = new Set(yourAgentIds.split(",").filter(Boolean));

    const readTopic = async (topicId: string) => {
      const response = await fetch(
        `${MIRROR_BASE}/api/v1/topics/${topicId}/messages?limit=100&order=asc`,
      );
      if (!response.ok) return [];
      const data = (await response.json()) as {
        messages?: Array<{ message: string; sequence_number: number }>;
      };
      const parsed: Array<{ body: Record<string, unknown>; sequence: number }> =
        [];
      for (const item of data.messages ?? []) {
        try {
          parsed.push({
            body: JSON.parse(atob(item.message)) as Record<string, unknown>,
            sequence: item.sequence_number,
          });
        } catch {
          // Not JSON; skip.
        }
      }
      return parsed;
    };

    const tick = async () => {
      if (mode === "market") {
        const next: Record<string, MarketBid[]> = {};
        await Promise.all(
          listings.map(async ({ itemId, topicId }) => {
            try {
              const messages = await readTopic(topicId);
              next[itemId] = messages
                .filter(
                  ({ body }) => body.type === "BID" && body.itemId === itemId,
                )
                .map(({ body, sequence }) => ({
                  bidder: String(body.bidder),
                  amountCents: Number(body.amountCents),
                  sequenceNumber: sequence,
                  yours: mine.has(String(body.bidder)),
                }));
            } catch {
              // Mirror hiccup; keep the previous view for this item.
            }
          }),
        );
        if (!cancelled && Object.keys(next).length > 0) {
          setBidsByItem((previous) => ({ ...previous, ...next }));
        }
        return;
      }

      const next: Record<string, LiveSellerBid[]> = {};
      await Promise.all(
        auctions.map(async ({ category, auctionId, topicId }) => {
          try {
            const messages = await readTopic(topicId);
            next[category] = messages
              .filter(
                ({ body }) =>
                  body.type === "BID" && body.auctionId === auctionId,
              )
              .map(({ body, sequence }) => ({
                sellerId: String(body.sellerId),
                sellerName: String(body.sellerName),
                offering: String(body.offering),
                amountCents: Number(body.amountCents),
                sequenceNumber: sequence,
              }));
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
  }, [topicsKey, yourAgentIds, mode, settlement]);

  if (!jobId || settlement === "idle" || settlement === "failed") {
    return undefined;
  }
  return {
    mode,
    agents,
    auctions,
    bidsByCategory,
    listings,
    bidsByItem,
    rivals,
    settledCategories,
    lostCategories,
    active: settlement === "pending",
    done: settlement === "settled",
  };
}
