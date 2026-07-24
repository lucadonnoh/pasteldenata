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
  createMockBuyerCompetition,
  type MockBuyerCompetition,
  type MockAgentSearch,
} from "@/src/mock-agent-search";

import styles from "./agent-search-experience.module.css";

const DISCOVERY_DURATION_MS = 4200;
const BID_INTERVAL_MS = 1000;
const AUCTION_SETTLE_MS = 1500;

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

function createBidEvents(competitions: MockBuyerCompetition[]) {
  const events: Array<{
    searchIndex: number;
    bidIndex: number;
    bid: MockBuyerCompetition["bids"][number];
  }> = [];

  competitions.forEach((competition, searchIndex) => {
    competition.bids.forEach((bid, bidIndex) => {
      events.push({ searchIndex, bidIndex, bid });
    });
  });

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
  const competitions = useMemo(
    () => searches.map(createMockBuyerCompetition),
    [searches],
  );
  const [phase, setPhase] = useState<
    "searching" | "bidding" | "complete"
  >("searching");
  const [resolvedCount, setResolvedCount] = useState(0);
  const [bidTick, setBidTick] = useState(0);
  const bidEvents = useMemo(
    () => createBidEvents(competitions),
    [competitions],
  );

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

  const activeEvent =
    bidEvents[Math.min(bidTick, bidEvents.length - 1)];
  const activeAuctionNumber = (activeEvent?.searchIndex ?? 0) + 1;
  const activeBidNumber = (activeEvent?.bidIndex ?? 0) + 1;

  const phaseCopy = {
    searching: {
      eyebrow: `${searches.length} AGENT WALLETS ACTIVE`,
      title: "Finding the right activities.",
      description:
        "Each agent sees one activity, one budget and nothing else.",
      status: "Discovering",
    },
    bidding: {
      eyebrow: "BUYER AGENTS · LIVE AUCTION",
      title: "Buyer agents are competing.",
      description:
        "The seller offer stays fixed while three buyer wallets raise the price.",
      status: `Auction ${activeAuctionNumber}/${
        searches.length
      } · Bid ${activeBidNumber}/6`,
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
          competitions={competitions}
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
  competitions,
  bidEvents,
  bidTick,
}: {
  competitions: MockBuyerCompetition[];
  bidEvents: ReturnType<typeof createBidEvents>;
  bidTick: number;
}) {
  const visibleEventCount = Math.min(
    bidTick + 1,
    bidEvents.length,
  );
  const activeEvent =
    bidEvents[Math.min(bidTick, bidEvents.length - 1)];
  const activeIndex = activeEvent?.searchIndex ?? 0;
  const activeCompetition =
    competitions[activeIndex] ?? competitions[0];

  if (!activeCompetition) return null;

  const currentBid = activeEvent?.bid;
  const visibleBids = activeCompetition.bids.slice(
    0,
    (activeEvent?.bidIndex ?? 0) + 1,
  );
  const marketWallets = activeCompetition.bids
    .filter((bid) => bid.kind === "market")
    .map((bid) => bid.wallet)
    .filter((wallet, index, wallets) => wallets.indexOf(wallet) === index);
  const buyerLabel = (bid: MockBuyerCompetition["bids"][number]) => {
    if (bid.kind === "user") return "YOUR AGENT";
    return `MARKET AGENT ${marketWallets.indexOf(bid.wallet) + 1}`;
  };

  return (
    <div className={styles.auctionStage}>
      <div className={styles.auctionTopline}>
        <span>
          <Gavel size={13} />
          THREE SEQUENTIAL AUCTIONS
        </span>
        <b>
          <Radio size={11} />
          LIVE BID {visibleEventCount.toString().padStart(2, "0")} /{" "}
          {bidEvents.length.toString().padStart(2, "0")}
        </b>
      </div>

      <nav className={styles.activityTabs} aria-label="Activity auctions">
        {competitions.map(({ search }, searchIndex) => {
          const CategoryIcon = categoryIcons[search.allocation.category];
          const isActive = searchIndex === activeIndex;
          const isComplete = searchIndex < activeIndex;
          return (
            <div
              className={`${styles.activityTab} ${
                isActive ? styles.activityTabActive : ""
              } ${isComplete ? styles.activityTabComplete : ""}`}
              key={search.id}
            >
              <span>
                <CategoryIcon size={17} />
              </span>
              <div>
                <small>AUCTION 0{searchIndex + 1}</small>
                <strong>{search.allocation.category}</strong>
              </div>
              <b>
                {isComplete ? (
                  <>
                    <Check size={11} />
                    WON
                  </>
                ) : isActive ? (
                  <>
                    <Radio size={10} />
                    LIVE
                  </>
                ) : (
                  "QUEUED"
                )}
              </b>
            </div>
          );
        })}
      </nav>

      <div className={styles.focusAuction}>
        <section
          className={styles.sellerOffer}
          data-category={activeCompetition.search.allocation.category}
        >
          <header>
            <span>
              {(() => {
                const CategoryIcon =
                  categoryIcons[
                    activeCompetition.search.allocation.category
                  ];
                return <CategoryIcon size={22} />;
              })()}
            </span>
            <div>
              <small>FIXED SELLER OFFER</small>
              <b>Seller does not bid</b>
            </div>
          </header>

          <h3>{activeCompetition.search.auction.winner.sellerName}</h3>
          <p>{activeCompetition.search.auction.winner.offering}</p>

          <div className={styles.offerRequirements}>
            {activeCompetition.search.allocation.requirements
              .slice(0, 3)
              .map((requirement) => (
                <span key={requirement}>{requirement}</span>
              ))}
          </div>

          <footer>
            <span>BUYER AGENT SPEND LIMIT</span>
            <strong>
              {formatUsd(
                activeCompetition.search.allocation.maxBudgetCents,
              )}
            </strong>
          </footer>
        </section>

        <section className={styles.buyerCompetition}>
          {currentBid && (
            <div
              className={`${styles.liveLeader} ${
                currentBid.kind === "user"
                  ? styles.liveLeaderUser
                  : ""
              }`}
              key={currentBid.id}
            >
              <div className={styles.leaderIdentity}>
                <span>
                  <Radio size={12} />
                  {currentBid.kind === "user"
                    ? "YOUR AGENT TAKES THE LEAD"
                    : "A MARKET AGENT TAKES THE LEAD"}
                </span>
                <strong>{buyerLabel(currentBid)}</strong>
                <code>{shortWallet(currentBid.wallet)}</code>
              </div>
              <div className={styles.currentPrice}>
                <span>CURRENT BID</span>
                <strong>{formatUsd(currentBid.amountCents)}</strong>
                <small>
                  Bid {(activeEvent?.bidIndex ?? 0) + 1} of{" "}
                  {activeCompetition.bids.length}
                </small>
              </div>
            </div>
          )}

          <div className={styles.bidHistory}>
            <header>
              <span>PRICE ESCALATION</span>
              <b>THREE BUYER WALLETS</b>
            </header>
            <div className={styles.bidHistoryGrid}>
              {activeCompetition.bids.map((bid, bidIndex) => {
                const isVisible = bidIndex < visibleBids.length;
                const isLatest = bidIndex === visibleBids.length - 1;

                return (
                  <div
                    className={`${styles.buyerBid} ${
                      isVisible ? styles.buyerBidVisible : ""
                    } ${isLatest ? styles.buyerBidLatest : ""} ${
                      bid.kind === "user" ? styles.buyerBidUser : ""
                    }`}
                    key={bid.id}
                  >
                    <span>0{bidIndex + 1}</span>
                    <div>
                      <strong>
                        {isVisible ? buyerLabel(bid) : "WAITING"}
                      </strong>
                      <code>
                        {isVisible ? shortWallet(bid.wallet) : "••••••••"}
                      </code>
                    </div>
                    <b>
                      {isVisible ? formatUsd(bid.amountCents) : "—"}
                    </b>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
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
