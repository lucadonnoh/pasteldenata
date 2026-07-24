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
  Sparkles,
  UtensilsCrossed,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { Category, DemoResult } from "@/src/domain";
import { formatUsd } from "@/src/money";
import {
  createMockAgentSearches,
  type MockAgentSearch,
} from "@/src/mock-agent-search";

import styles from "./agent-search-experience.module.css";

const DISCOVERY_DURATION_MS = 2900;
const AUCTION_DURATION_MS = 4200;

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

  useEffect(() => {
    let bidTimer: number | undefined;
    const resolutionTimers = searches.map((_, index) =>
      window.setTimeout(
        () => setResolvedCount(index + 1),
        850 + index * 560,
      ),
    );
    const auctionTimer = window.setTimeout(
      () => {
        setPhase("bidding");
        bidTimer = window.setInterval(
          () => setBidTick((current) => current + 1),
          720,
        );
      },
      DISCOVERY_DURATION_MS,
    );
    const completionTimer = window.setTimeout(
      () => {
        if (bidTimer !== undefined) window.clearInterval(bidTimer);
        setPhase("complete");
      },
      DISCOVERY_DURATION_MS + AUCTION_DURATION_MS,
    );

    return () => {
      resolutionTimers.forEach(window.clearTimeout);
      window.clearTimeout(auctionTimer);
      if (bidTimer !== undefined) window.clearInterval(bidTimer);
      window.clearTimeout(completionTimer);
    };
  }, [searches]);

  const phaseCopy = {
    searching: {
      eyebrow: `${searches.length} AGENT WALLETS ACTIVE`,
      title: "Finding the right activities.",
      description:
        "Each agent sees one activity, one budget and nothing else.",
      status: "Dreaming",
    },
    bidding: {
      eyebrow: "ACTIVITIES LOCKED · AUCTIONS OPEN",
      title: `${searches.length} activities. ${searches.length} live auctions.`,
      description:
        "Seller bids arrive independently inside each scoped market.",
      status: "Auction live",
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
        <DreamOrbit searches={searches} resolvedCount={resolvedCount} />
      ) : phase === "bidding" ? (
        <BidAuctionStage searches={searches} bidTick={bidTick} />
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

function DreamOrbit({
  searches,
  resolvedCount,
}: {
  searches: MockAgentSearch[];
  resolvedCount: number;
}) {
  return (
    <>
      <div className={styles.orbitScene} aria-label="Agent market search">
        <div className={styles.dreamWash} />
        <div className={styles.orbitLine} />
        <div className={styles.core}>
          <Sparkles size={18} />
          <strong>{searches.length}</strong>
          <span>scoped agents</span>
        </div>

        {searches.map((search, index) => {
          const CategoryIcon = categoryIcons[search.allocation.category];
          const isResolved = index < resolvedCount;
          const delay = -((index * 9) / searches.length);
          const orbitStyle = {
            "--agent-delay": `${delay}s`,
          } as CSSProperties;

          return (
            <div
              className={styles.orbitSlot}
              style={orbitStyle}
              key={search.id}
            >
              <div className={styles.orbitTraveller}>
                <article
                  className={`${styles.orbitCard} ${
                    isResolved ? styles.found : ""
                  }`}
                >
                  <header>
                    <span>
                      <CategoryIcon size={14} />
                    </span>
                    <b>
                      {isResolved ? (
                        <>
                          <Check size={10} />
                          Match
                        </>
                      ) : (
                        "Discovering"
                      )}
                    </b>
                  </header>
                  <h3>{search.allocation.category}</h3>
                  <code>{shortWallet(search.wallet)}</code>
                  <footer>
                    <WalletCards size={11} />
                    {search.auction.bids.length} sellers · cap{" "}
                    {formatUsd(search.allocation.maxBudgetCents)}
                  </footer>
                </article>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.agentLedger}>
        {searches.map((search, index) => (
          <div key={search.id}>
            <span className={index < resolvedCount ? styles.ledgerFound : ""}>
              {index < resolvedCount ? <Check size={9} /> : index + 1}
            </span>
            <div>
              <strong>{search.allocation.category} agent</strong>
              <code>{shortWallet(search.wallet)}</code>
            </div>
            <b>
              {index < resolvedCount
                ? `${search.auction.bids.length} sellers ready`
                : "scanning"}
            </b>
          </div>
        ))}
      </div>
    </>
  );
}

function BidAuctionStage({
  searches,
  bidTick,
}: {
  searches: MockAgentSearch[];
  bidTick: number;
}) {
  const largestAuction = Math.max(
    ...searches.map((search) => search.auction.bids.length),
  );
  const currentRound = Math.min(bidTick + 1, largestAuction);

  return (
    <div className={styles.auctionStage}>
      <div className={styles.auctionTopline}>
        <span>
          <Gavel size={13} />
          LIVE BID ESCALATION
        </span>
        <b>
          <Radio size={11} />
          ROUND {currentRound.toString().padStart(2, "0")} /{" "}
          {largestAuction.toString().padStart(2, "0")}
        </b>
      </div>

      <div className={styles.auctionGrid}>
        {searches.map((search, searchIndex) => {
          const CategoryIcon = categoryIcons[search.allocation.category];
          const visibleBidCount = Math.min(
            bidTick + 1,
            search.auction.bids.length,
          );
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
          const leader = rankedBids.reduce(
            (currentLeader, bid) => {
              const currentScore =
                search.auction.evaluations.find(
                  (evaluation) =>
                    evaluation.sellerId === currentLeader.sellerId,
                )?.score ?? Number.NEGATIVE_INFINITY;
              const bidScore =
                search.auction.evaluations.find(
                  (evaluation) => evaluation.sellerId === bid.sellerId,
                )?.score ?? Number.NEGATIVE_INFINITY;
              return bidScore > currentScore ? bid : currentLeader;
            },
            rankedBids[0] ?? search.auction.winner,
          );

          return (
            <article
              className={styles.auctionLane}
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

              <div className={styles.bidStack}>
                {search.auction.bids.map((bid, bidIndex) => {
                  const isVisible = bidIndex < visibleBidCount;
                  const isLeading =
                    isVisible && bid.sellerId === leader.sellerId;

                  return (
                    <div
                      className={`${styles.bidRow} ${
                        isVisible ? styles.bidVisible : ""
                      } ${isLeading ? styles.bidLeading : ""}`}
                      key={bid.sellerId}
                    >
                      <span>{(bidIndex + 1).toString().padStart(2, "0")}</span>
                      <div>
                        <strong>{isVisible ? bid.sellerName : "Waiting"}</strong>
                        <small>
                          {isVisible
                            ? `${bid.quality}/100 quality`
                            : "Seller bid sealed"}
                        </small>
                      </div>
                      <b>{isVisible ? formatUsd(bid.amountCents) : "—"}</b>
                      {isLeading && <i>LEADING</i>}
                    </div>
                  );
                })}
              </div>

              <footer className={styles.auctionLeader}>
                <span>Current leader</span>
                <strong>{leader.sellerName}</strong>
                <b>{formatUsd(leader.amountCents)}</b>
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
