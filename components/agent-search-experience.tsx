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
  ShieldCheck,
  UtensilsCrossed,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Category, DemoResult } from "@/src/domain";
import { formatUsd } from "@/src/money";
import {
  createMockAgentSearches,
  createMockBuyerCompetitions,
  type MockBuyerCompetition,
  type MockAgentSearch,
} from "@/src/mock-agent-search";

import styles from "./agent-search-experience.module.css";

const DISCOVERY_DURATION_MS = 4200;
const BID_INTERVAL_MS = 1050;
const LOST_AUCTION_HOLD_MS = 3400;
const RETRY_OFFER_HOLD_MS = 1800;
const AUCTION_SETTLE_MS = 1500;

const categoryIcons: Record<Category, LucideIcon> = {
  flowers: Flower2,
  cinema: Clapperboard,
  dinner: UtensilsCrossed,
  transport: CarFront,
  experience: Palette,
};

const recoveryTargets: Record<Category, string> = {
  flowers: "florist",
  cinema: "cinema",
  dinner: "restaurant",
  transport: "ride",
  experience: "experience",
};

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

function createBidEvents(competitions: MockBuyerCompetition[]) {
  const events: Array<{
    competitionIndex: number;
    bidIndex: number;
    bid: MockBuyerCompetition["bids"][number];
  }> = [];

  competitions.forEach((competition, competitionIndex) => {
    competition.bids.forEach((bid, bidIndex) => {
      events.push({ competitionIndex, bidIndex, bid });
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
  const recoveryIndex = searches.length > 1 ? 1 : 0;
  const competitions = useMemo(
    () =>
      searches.flatMap((search, index) =>
        createMockBuyerCompetitions(search, index === recoveryIndex),
      ),
    [recoveryIndex, searches],
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
    const resolutionTimers = searches.map((_, index) =>
      window.setTimeout(
        () => setResolvedCount(index + 1),
        1100 + index * 900,
      ),
    );
    const auctionTimer = window.setTimeout(
      () => {
        setPhase("bidding");
      },
      DISCOVERY_DURATION_MS,
    );

    return () => {
      resolutionTimers.forEach(window.clearTimeout);
      window.clearTimeout(auctionTimer);
    };
  }, [searches]);

  useEffect(() => {
    if (phase !== "bidding") return;

    const event =
      bidEvents[Math.min(bidTick, bidEvents.length - 1)];
    const competition = event
      ? competitions[event.competitionIndex]
      : undefined;

    if (!event || !competition) {
      const emptyTimer = window.setTimeout(
        () => setPhase("complete"),
        AUCTION_SETTLE_MS,
      );
      return () => window.clearTimeout(emptyTimer);
    }

    const isLastEvent = bidTick >= bidEvents.length - 1;
    const isRoundResolution =
      event.bidIndex === competition.bids.length - 1;
    const delay = isLastEvent
      ? AUCTION_SETTLE_MS
      : isRoundResolution && competition.outcome === "lost"
        ? LOST_AUCTION_HOLD_MS
        : competition.attempt > 1 && event.bidIndex === 0
          ? RETRY_OFFER_HOLD_MS
          : BID_INTERVAL_MS;
    const bidTimer = window.setTimeout(() => {
      if (isLastEvent) {
        setPhase("complete");
        return;
      }
      setBidTick((current) =>
        Math.min(current + 1, bidEvents.length - 1),
      );
    }, delay);

    return () => window.clearTimeout(bidTimer);
  }, [bidEvents, bidTick, competitions, phase]);

  const activeEvent =
    bidEvents[Math.min(bidTick, bidEvents.length - 1)];
  const activeCompetition = activeEvent
    ? competitions[activeEvent.competitionIndex]
    : competitions[0];
  const activeAuctionNumber =
    searches.findIndex(
      (search) => search.id === activeCompetition?.search.id,
    ) + 1;
  const activeBidNumber = (activeEvent?.bidIndex ?? 0) + 1;
  const lostAuctionResolved =
    activeCompetition?.outcome === "lost" &&
    activeBidNumber === activeCompetition.bids.length;
  const retryOfferFound =
    (activeCompetition?.attempt ?? 1) > 1 &&
    activeBidNumber === 1;

  const phaseCopy = {
    searching: {
      eyebrow: `${searches.length} AGENT WALLETS ACTIVE`,
      title: "Finding the right activities.",
      description:
        "Each agent sees one activity, one budget and nothing else.",
      status: "Discovering",
    },
    bidding: {
      eyebrow: lostAuctionResolved
        ? "AUCTION LOST · MANDATE PROTECTED"
        : retryOfferFound
          ? "ALTERNATIVE SELLER FOUND"
          : "BUYER AGENTS · LIVE AUCTION",
      title: lostAuctionResolved
        ? "Outbid. Walking away."
        : retryOfferFound
          ? "New offer. Bidding again."
          : "Buyer agents are competing.",
      description: lostAuctionResolved
        ? "The market passed this wallet’s cap. It will not overspend."
        : retryOfferFound
          ? "The same buyer wallet found another seller inside its mandate."
          : "The seller offer stays fixed while three buyer wallets raise the price.",
      status: `Activity ${Math.max(activeAuctionNumber, 1)}/${
        searches.length
      } · Try ${activeCompetition?.attempt ?? 1} · Bid ${activeBidNumber}`,
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
  searches,
  competitions,
  bidEvents,
  bidTick,
}: {
  searches: MockAgentSearch[];
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
  const activeIndex = activeEvent?.competitionIndex ?? 0;
  const activeCompetition =
    competitions[activeIndex] ?? competitions[0];
  const visibleBidCount = (activeEvent?.bidIndex ?? 0) + 1;
  const bidListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const bidList = bidListRef.current;
      if (!bidList) return;

      bidList.scrollTo({
        top: bidList.scrollHeight,
        behavior: visibleBidCount > 1 ? "smooth" : "auto",
      });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeIndex, visibleBidCount]);

  if (!activeCompetition) return null;

  const currentBid = activeEvent?.bid;
  const visibleBids = activeCompetition.bids.slice(
    0,
    visibleBidCount,
  );
  const activeSearchIndex = searches.findIndex(
    (search) => search.id === activeCompetition.search.id,
  );
  const roundIsResolved =
    visibleBidCount === activeCompetition.bids.length;
  const roundIsLost =
    activeCompetition.outcome === "lost" && roundIsResolved;
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
          {roundIsLost
            ? "MANDATE CAP REACHED · FINDING ANOTHER SELLER"
            : activeCompetition.attempt > 1
              ? "ALTERNATIVE OFFER · SECOND ATTEMPT"
              : "MULTI-AGENT PROCUREMENT"}
        </span>
        <b>
          {roundIsLost ? <ShieldCheck size={11} /> : <Radio size={11} />}
          {roundIsLost
            ? "BUDGET PROTECTED"
            : `LIVE BID ${visibleEventCount.toString().padStart(2, "0")}`}
        </b>
      </div>

      <nav className={styles.activityTabs} aria-label="Activity auctions">
        {searches.map((search, searchIndex) => {
          const CategoryIcon = categoryIcons[search.allocation.category];
          const searchCompetitions = competitions.filter(
            (competition) => competition.search.id === search.id,
          );
          const lastCompetitionIndex = competitions.reduce(
            (lastIndex, competition, competitionIndex) =>
              competition.search.id === search.id
                ? competitionIndex
                : lastIndex,
            -1,
          );
          const isActive = searchIndex === activeSearchIndex;
          const isComplete = lastCompetitionIndex < activeIndex;
          const retried = searchCompetitions.length > 1;
          return (
            <div
              className={`${styles.activityTab} ${
                isActive ? styles.activityTabActive : ""
              } ${isComplete ? styles.activityTabComplete : ""} ${
                isActive && roundIsLost ? styles.activityTabLost : ""
              }`}
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
                    {retried ? "WON · TRY 2" : "WON"}
                  </>
                ) : isActive && roundIsLost ? (
                  <>
                    <X size={11} />
                    LOST
                  </>
                ) : isActive ? (
                  <>
                    <Radio size={10} />
                    {activeCompetition.attempt > 1 ? "RETRY" : "LIVE"}
                  </>
                ) : (
                  "QUEUED"
                )}
              </b>
            </div>
          );
        })}
      </nav>

      <div
        className={`${styles.focusAuction} ${
          roundIsLost ? styles.focusAuctionRecovering : ""
        }`}
      >
        <section
          className={styles.sellerOffer}
          data-category={activeCompetition.search.allocation.category}
          data-attempt={activeCompetition.attempt}
          key={activeCompetition.offer.sellerId}
          aria-hidden={roundIsLost}
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
              <small>
                {activeCompetition.attempt > 1
                  ? "NEW SELLER OFFER"
                  : "FIXED SELLER OFFER"}
              </small>
              <b>
                Attempt {activeCompetition.attempt} · Seller does not bid
              </b>
            </div>
          </header>

          <h3>{activeCompetition.offer.sellerName}</h3>
          <p>{activeCompetition.offer.offering}</p>

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

        <section
          className={styles.buyerCompetition}
          aria-hidden={roundIsLost}
        >
          {currentBid && (
            <div
              className={`${styles.liveLeader} ${
                currentBid.kind === "user"
                  ? styles.liveLeaderUser
                  : ""
              } ${roundIsLost ? styles.liveLeaderLost : ""}`}
              key={currentBid.id}
            >
              <div className={styles.leaderIdentity}>
                <span>
                  {roundIsLost ? (
                    <ShieldCheck size={12} />
                  ) : (
                    <Radio size={12} />
                  )}
                  {roundIsLost
                    ? "MARKET AGENT WINS · YOUR AGENT STOPS"
                    : currentBid.kind === "user"
                    ? "YOUR AGENT TAKES THE LEAD"
                    : "A MARKET AGENT TAKES THE LEAD"}
                </span>
                <strong>{buyerLabel(currentBid)}</strong>
                <code>{shortWallet(currentBid.wallet)}</code>
              </div>
              <div className={styles.currentPrice}>
                <span>
                  {roundIsLost ? "FINAL MARKET BID" : "CURRENT BID"}
                </span>
                <strong>{formatUsd(currentBid.amountCents)}</strong>
                <small>
                  {roundIsLost
                    ? `Your cap ${formatUsd(
                        activeCompetition.search.allocation
                          .maxBudgetCents,
                      )}`
                    : `Bid ${(activeEvent?.bidIndex ?? 0) + 1}`}
                </small>
              </div>
            </div>
          )}

          <div className={styles.bidHistory}>
            <header>
              <span>LIVE BID FEED</span>
              <b>AUTO-FOLLOW ↓</b>
            </header>
            <div
              className={styles.bidHistoryList}
              aria-label="Incoming buyer bids"
              ref={bidListRef}
            >
              {visibleBids.map((bid, bidIndex) => {
                const isLatest = bidIndex === visibleBids.length - 1;
                return (
                  <div
                    className={`${styles.buyerBid} ${styles.buyerBidVisible} ${
                      isLatest ? styles.buyerBidLatest : ""
                    } ${
                      bid.kind === "user" ? styles.buyerBidUser : ""
                    }`}
                    key={bid.id}
                  >
                    <span>
                      {(bidIndex + 1).toString().padStart(2, "0")}
                    </span>
                    <div>
                      <strong>{buyerLabel(bid)}</strong>
                      <code>{shortWallet(bid.wallet)}</code>
                    </div>
                    <b>{formatUsd(bid.amountCents)}</b>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {roundIsLost && (
          <div className={styles.recoveryOverlay} role="status">
            <div className={styles.lostStamp}>
              <X size={22} />
              <strong>LOST</strong>
              <span>OUTBID ABOVE CAP</span>
            </div>

            <div className={styles.recoverySearch}>
              <span>
                <ScanSearch size={14} />
                BUYER AGENT RECOVERY
              </span>
              <h3>
                Finding another{" "}
                {
                  recoveryTargets[
                    activeCompetition.search.allocation.category
                  ]
                }
                …
              </h3>
              <p>
                {shortWallet(activeCompetition.search.wallet)} protected its{" "}
                {formatUsd(
                  activeCompetition.search.allocation.maxBudgetCents,
                )}{" "}
                mandate and restarted discovery.
              </p>
              <div className={styles.recoveryTrack}>
                <i />
              </div>
              <small>SCANNING ELIGIBLE SELLERS</small>
            </div>
          </div>
        )}
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
