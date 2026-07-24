"use client";

import {
  CarFront,
  Check,
  Clapperboard,
  Flower2,
  Gavel,
  Palette,
  Radio,
  RotateCcw,
  ScanSearch,
  UtensilsCrossed,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Category, DemoResult } from "@/src/domain";
import { formatUsd } from "@/src/money";
import {
  createMockAgentSearches,
  mockSellerAgentWallet,
  type MockAgentSearch,
} from "@/src/mock-agent-search";

import styles from "./agent-search-experience.module.css";

const DISCOVERY_DURATION_MS = 4200;
const BID_INTERVAL_MS = 1100;
const AUCTION_SETTLE_MS = 1800;

const categoryIcons: Record<Category, LucideIcon> = {
  flowers: Flower2,
  cinema: Clapperboard,
  dinner: UtensilsCrossed,
  transport: CarFront,
  experience: Palette,
};

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

function createBidEvents(searches: MockAgentSearch[]) {
  const events: Array<{
    searchIndex: number;
    bidIndex: number;
    bid: MockAgentSearch["auction"]["bids"][number];
  }> = [];
  const largestAuction = Math.max(
    0,
    ...searches.map((search) => search.auction.bids.length),
  );

  for (let bidIndex = 0; bidIndex < largestAuction; bidIndex += 1) {
    searches.forEach((search, searchIndex) => {
      const bid = search.auction.bids[bidIndex];
      if (bid) events.push({ searchIndex, bidIndex, bid });
    });
  }

  return events;
}

export function AgentSearchExperience({ result }: { result: DemoResult }) {
  const searches = useMemo(() => createMockAgentSearches(result), [result]);
  const [run, setRun] = useState(0);

  return (
    <AgentSearchRun
      key={`${result.plan.planId}:${run}`}
      result={result}
      searches={searches}
      onReplay={() => setRun((current) => current + 1)}
    />
  );
}

function AgentSearchRun({
  result,
  searches,
  onReplay,
}: {
  result: DemoResult;
  searches: MockAgentSearch[];
  onReplay: () => void;
}) {
  const [phase, setPhase] = useState<
    "searching" | "bidding" | "complete"
  >("searching");
  const [resolvedCount, setResolvedCount] = useState(0);
  const [bidTick, setBidTick] = useState(0);
  const bidEvents = useMemo(() => createBidEvents(searches), [searches]);

  useEffect(() => {
    let bidTimer: number | undefined;
    const resolutionTimers = searches.map((_, index) =>
      window.setTimeout(
        () => setResolvedCount(index + 1),
        1100 + index * 900,
      ),
    );
    const auctionTimer = window.setTimeout(
      () => {
        setPhase("bidding");
        bidTimer = window.setInterval(
          () => setBidTick((current) => current + 1),
          BID_INTERVAL_MS,
        );
      },
      DISCOVERY_DURATION_MS,
    );
    const completionTimer = window.setTimeout(
      () => {
        if (bidTimer !== undefined) window.clearInterval(bidTimer);
        setPhase("complete");
      },
      DISCOVERY_DURATION_MS +
        bidEvents.length * BID_INTERVAL_MS +
        AUCTION_SETTLE_MS,
    );

    return () => {
      resolutionTimers.forEach(window.clearTimeout);
      window.clearTimeout(auctionTimer);
      if (bidTimer !== undefined) window.clearInterval(bidTimer);
      window.clearTimeout(completionTimer);
    };
  }, [bidEvents.length, searches]);

  const visibleBidEvent = Math.min(
    bidTick + 1,
    bidEvents.length,
  );

  const phaseCopy = {
    searching: {
      eyebrow: `${searches.length} AGENT WALLETS ACTIVE`,
      title: "Finding the right activities.",
      description:
        "Each agent sees one activity, one budget and nothing else.",
      status: "Discovering",
    },
    bidding: {
      eyebrow: "SELLER AGENTS · LIVE COMPETITION",
      title: "Seller agents are competing now.",
      description:
        "One sealed bid is revealed at a time. Watch the best-value leader change.",
      status: `Bid ${visibleBidEvent}/${bidEvents.length}`,
    },
    complete: {
      eyebrow: "BUNDLE ASSEMBLED",
      title: result.plan.occasionTitle,
      description: `${result.plan.location} · ${result.plan.scheduledFor}`,
      status: "Ready",
    },
  }[phase];

  return (
    <section className={styles.experience} aria-live="polite">
      <header className={styles.heading}>
        <div>
          <span>{phaseCopy.eyebrow}</span>
          <h2>{phaseCopy.title}</h2>
          <p>{phaseCopy.description}</p>
        </div>
        <div className={styles.phasePill}>
          <i
            className={
              phase === "complete"
                ? styles.completeDot
                : phase === "bidding"
                  ? styles.auctionDot
                  : ""
            }
          />
          {phaseCopy.status}
        </div>
      </header>

      {phase === "searching" ? (
        <ActivityDiscovery
          searches={searches}
          resolvedCount={resolvedCount}
        />
      ) : phase === "bidding" ? (
        <BidAuctionStage
          searches={searches}
          bidEvents={bidEvents}
          bidTick={bidTick}
        />
      ) : (
        <>
          <div className={styles.bundleGrid}>
            {searches.map((search, index) => (
              <ResultCard
                key={search.id}
                search={search}
                index={index}
              />
            ))}
          </div>
          <button
            className={styles.replayButton}
            type="button"
            onClick={onReplay}
          >
            <RotateCcw size={13} />
            Replay agent search
          </button>
        </>
      )}
    </section>
  );
}

function ActivityDiscovery({
  searches,
  resolvedCount,
}: {
  searches: MockAgentSearch[];
  resolvedCount: number;
}) {
  return (
    <div className={styles.discoveryStage}>
      <div className={styles.discoveryProgress}>
        <span>
          <ScanSearch size={12} />
          DISCOVERING ACTIVITIES
        </span>
        <div>
          {searches.map((search, index) => (
            <i
              className={
                index < resolvedCount ? styles.discoveryStepDone : ""
              }
              key={search.id}
            />
          ))}
        </div>
        <b>
          {resolvedCount}/{searches.length} FOUND
        </b>
      </div>

      <div className={styles.discoveryGrid}>
        {searches.map((search, index) => {
          const CategoryIcon = categoryIcons[search.allocation.category];
          const isResolved = index < resolvedCount;

          return (
            <article
              className={`${styles.discoveryCard} ${
                isResolved ? styles.activityFound : ""
              }`}
              key={search.id}
            >
              <header>
                <span>
                  <CategoryIcon size={17} />
                </span>
                <b>
                  {isResolved ? (
                    <>
                      <Check size={10} />
                      Activity found
                    </>
                  ) : (
                    <>
                      <i />
                      Searching
                    </>
                  )}
                </b>
              </header>

              <div className={styles.discoveryWallet}>
                <span>AGENT WALLET 0{index + 1}</span>
                <code>{shortWallet(search.wallet)}</code>
              </div>

              <h3>{search.allocation.category}</h3>
              <p>
                {search.allocation.requirements.slice(0, 3).join(" · ")}
              </p>

              <footer>
                <span>
                  <WalletCards size={11} />
                  {search.auction.bids.length} eligible sellers
                </span>
                <strong>
                  cap {formatUsd(search.allocation.maxBudgetCents)}
                </strong>
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function BidAuctionStage({
  searches,
  bidEvents,
  bidTick,
}: {
  searches: MockAgentSearch[];
  bidEvents: ReturnType<typeof createBidEvents>;
  bidTick: number;
}) {
  const visibleEventCount = Math.min(
    bidTick + 1,
    bidEvents.length,
  );
  const revealedEvents = bidEvents.slice(0, visibleEventCount);
  const activeEvent =
    bidEvents[Math.min(bidTick, bidEvents.length - 1)];

  return (
    <div className={styles.auctionStage}>
      <div className={styles.auctionTopline}>
        <span>
          <Gavel size={13} />
          AGENT BID COMPETITION
        </span>
        <b>
          <Radio size={11} />
          BID {visibleEventCount.toString().padStart(2, "0")} /{" "}
          {bidEvents.length.toString().padStart(2, "0")}
        </b>
      </div>

      {activeEvent && (
        <div
          className={styles.bidEvent}
          key={`${activeEvent.searchIndex}-${activeEvent.bid.sellerId}`}
        >
          <span>
            <Radio size={13} />
            SELLER AGENT BIDS
          </span>
          <div>
            <strong>{activeEvent.bid.sellerName}</strong>
            <small>
              {shortWallet(
                mockSellerAgentWallet(activeEvent.bid.sellerId),
              )}{" "}
              enters the{" "}
              {searches[activeEvent.searchIndex]?.allocation.category} market
            </small>
          </div>
          <b>{formatUsd(activeEvent.bid.amountCents)}</b>
          <i>Best value = quality + fit + price</i>
        </div>
      )}

      <div className={styles.auctionGrid}>
        {searches.map((search, searchIndex) => {
          const CategoryIcon = categoryIcons[search.allocation.category];
          const visibleBidCount = revealedEvents.filter(
            (event) => event.searchIndex === searchIndex,
          ).length;
          const isActiveLane =
            activeEvent?.searchIndex === searchIndex;
          const activeSellerId = isActiveLane
            ? activeEvent.bid.sellerId
            : undefined;
          const visibleBids = search.auction.bids.slice(
            0,
            visibleBidCount,
          );
          const affordableBids = visibleBids.filter(
            (bid) =>
              search.auction.evaluations.find(
                (evaluation) => evaluation.sellerId === bid.sellerId,
              )?.affordable,
          );
          const rankedBids =
            affordableBids.length > 0 ? affordableBids : visibleBids;
          const leader =
            rankedBids.length > 0
              ? rankedBids.reduce((currentLeader, bid) => {
                  const currentScore =
                    search.auction.evaluations.find(
                      (evaluation) =>
                        evaluation.sellerId ===
                        currentLeader.sellerId,
                    )?.score ?? Number.NEGATIVE_INFINITY;
                  const bidScore =
                    search.auction.evaluations.find(
                      (evaluation) =>
                        evaluation.sellerId === bid.sellerId,
                    )?.score ?? Number.NEGATIVE_INFINITY;
                  return bidScore > currentScore
                    ? bid
                    : currentLeader;
                })
              : null;
          const leaderScore = leader
            ? (search.auction.evaluations.find(
                (evaluation) =>
                  evaluation.sellerId === leader.sellerId,
              )?.score ?? 0)
            : 0;
          const sealedBidCount =
            search.auction.bids.length - visibleBidCount;

          return (
            <article
              className={`${styles.auctionLane} ${
                isActiveLane ? styles.auctionLaneActive : ""
              }`}
              data-category={search.allocation.category}
              key={search.id}
            >
              <header className={styles.auctionLaneHeader}>
                <span>
                  <CategoryIcon size={16} />
                </span>
                <div>
                  <strong>{search.allocation.category}</strong>
                  <code>{shortWallet(search.wallet)}</code>
                </div>
                <b>0{searchIndex + 1}</b>
              </header>

              <div className={styles.activityScope}>
                <span>ACTIVITY FOUND</span>
                <strong>
                  {search.allocation.requirements.slice(0, 2).join(" · ")}
                </strong>
                <p>
                  Scoped cap{" "}
                  {formatUsd(search.allocation.maxBudgetCents)}
                </p>
              </div>

              <div
                className={styles.currentBest}
                key={`${search.id}-${leader?.sellerId ?? "waiting"}`}
              >
                <div>
                  <span>LEADING SELLER AGENT</span>
                  <strong>
                    {leader?.sellerName ?? "Waiting for first bid"}
                  </strong>
                  <small>
                    {leader
                      ? `${shortWallet(
                          mockSellerAgentWallet(leader.sellerId),
                        )} · score ${leaderScore.toFixed(1)}`
                      : "sealed market"}
                  </small>
                </div>
                <b>
                  {leader ? formatUsd(leader.amountCents) : "—"}
                </b>
              </div>

              <div className={styles.bidStack}>
                {visibleBids.map((bid, bidIndex) => {
                  const isLeading =
                    bid.sellerId === leader?.sellerId;
                  const isNewest =
                    bid.sellerId === activeSellerId;

                  return (
                    <div
                      className={`${styles.bidRow} ${styles.bidVisible} ${
                        isLeading ? styles.bidLeading : ""
                      } ${isNewest ? styles.bidNewest : ""}`}
                      key={bid.sellerId}
                    >
                      <span>{(bidIndex + 1).toString().padStart(2, "0")}</span>
                      <div>
                        <strong>{bid.sellerName}</strong>
                        <small>
                          {shortWallet(
                            mockSellerAgentWallet(bid.sellerId),
                          )}{" "}
                          · {bid.quality}/100 quality
                        </small>
                      </div>
                      <b>{formatUsd(bid.amountCents)}</b>
                      {isLeading && <i>BEST VALUE</i>}
                    </div>
                  );
                })}
              </div>

              <footer className={styles.sealedStatus}>
                {sealedBidCount > 0 ? (
                  <>
                    <i />
                    {sealedBidCount} sealed{" "}
                    {sealedBidCount === 1 ? "bid" : "bids"} waiting
                  </>
                ) : (
                  <>
                    <Check size={10} />
                    All seller bids revealed
                  </>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ResultCard({
  search,
  index,
}: {
  search: MockAgentSearch;
  index: number;
}) {
  const CategoryIcon = categoryIcons[search.allocation.category];
  const visibleTags =
    search.matchedTags.length > 0
      ? search.matchedTags
      : search.auction.winner.tags.slice(0, 2);

  return (
    <article
      className={styles.resultCard}
      data-category={search.allocation.category}
    >
      <div className={styles.resultArt}>
        <span className={styles.artOrb} />
        <span className={styles.artGlass} />
        <CategoryIcon size={30} />
        <b>0{index + 1}</b>
      </div>

      <div className={styles.resultBody}>
        <header>
          <span>{search.allocation.category}</span>
          <b>
            <Check size={9} />
            Matched
          </b>
        </header>
        <h3>{search.auction.winner.sellerName}</h3>
        <p>{search.auction.winner.offering}</p>

        <div className={styles.tags}>
          {visibleTags.slice(0, 3).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>

        <div className={styles.resultFooter}>
          <div>
            <span>Agent wallet</span>
            <code>{shortWallet(search.wallet)}</code>
          </div>
          <strong>{formatUsd(search.auction.winner.amountCents)}</strong>
        </div>
      </div>
    </article>
  );
}
