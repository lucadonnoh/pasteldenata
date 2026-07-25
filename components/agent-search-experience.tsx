"use client";

import {
  CarFront,
  Check,
  CheckCircle2,
  Clapperboard,
  Clock3,
  ExternalLink,
  Flower2,
  Gavel,
  Palette,
  RotateCcw,
  Store,
  Users,
  UtensilsCrossed,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  Category,
  DemoResult,
  EnglishAuctionStep,
} from "@/src/domain";
import { formatUsd } from "@/src/money";
import {
  createMockAgentSearches,
  createMockAuctionReplays,
  type MockAgentSearch,
  type MockAuctionReplay,
} from "@/src/mock-agent-search";
import type { LiveAuctionView } from "@/components/use-settlement-job";

import styles from "./agent-search-experience.module.css";

const categoryIcons: Record<Category, LucideIcon> = {
  flowers: Flower2,
  cinema: Clapperboard,
  dinner: UtensilsCrossed,
  transport: CarFront,
  experience: Palette,
};

interface ReplayFrame {
  replayIndex: number;
  stepIndex: number | null;
}

function buildFrames(replays: MockAuctionReplay[]): ReplayFrame[] {
  return replays.flatMap(
    (replay, replayIndex): ReplayFrame[] =>
      replay.listingAuction.steps.length > 0
        ? replay.listingAuction.steps.map((_, stepIndex) => ({
            replayIndex,
            stepIndex,
          }))
        : [{ replayIndex, stepIndex: null }],
  );
}

function lastFrameForReplay(
  frames: ReplayFrame[],
  replayIndex: number,
): number {
  return frames.findLastIndex((frame) => frame.replayIndex === replayIndex);
}

function statusLabel(replay: MockAuctionReplay): string {
  if (replay.listingAuction.status === "won") return "buyer won";
  if (replay.listingAuction.status === "lost") return "mock rival won";
  return "floor not met";
}

export function AgentSearchExperience({
  result,
  live,
}: {
  result: DemoResult;
  live?: LiveAuctionView;
}) {
  // Settlement replaces the session result with on-chain receipts. Keep the
  // already-recorded mock trace stable while those receipts arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const searches = useMemo(
    () => createMockAgentSearches(result),
    [result.plan.planId],
  );
  const replays = useMemo(
    () => createMockAuctionReplays(searches),
    [searches],
  );
  const frames = useMemo(() => buildFrames(replays), [replays]);
  const [run, setRun] = useState(0);

  if (live) {
    return (
      <LiveAgentSearchRun result={result} searches={searches} live={live} />
    );
  }

  return (
    <AgentSearchRun
      key={`${result.plan.planId}:${run}`}
      result={result}
      searches={searches}
      replays={replays}
      frames={frames}
      onReplay={() => setRun((current) => current + 1)}
    />
  );
}

/**
 * The real thing: phases driven by the settlement job instead of timers.
 * Wallets appear as the swarm funds them, the bidding stage streams actual
 * HCS bids read from Mirror Node, and the result cards carry the on-chain
 * receipts.
 */
function LiveAgentSearchRun({
  result,
  searches,
  live,
}: {
  result: DemoResult;
  searches: MockAgentSearch[];
  live: LiveAuctionView;
}) {
  const market = live.mode === "market";
  const totalBids = market
    ? Object.values(live.bidsByItem).reduce(
        (sum, bids) => sum + bids.length,
        0,
      )
    : Object.values(live.bidsByCategory).reduce(
        (sum, bids) => sum + bids.length,
        0,
      );
  const yourAgents = live.agents.filter(
    (agent) => agent.buyerName === "You",
  );
  const opened = market
    ? live.listings.length > 0
    : live.auctions.length > 0;
  const phase: "searching" | "bidding" | "complete" = live.done
    ? "complete"
    : opened
      ? "bidding"
      : "searching";
  const wonCount = result.receipts.filter(
    (receipt) => receipt.status === "hedera-settled",
  ).length;

  const phaseCopy = {
    searching: {
      eyebrow: market
        ? `OPEN MARKET · ${live.rivals.length} RIVAL BUYERS ACTIVE`
        : `${searches.length} AGENT WALLETS FUNDING ON HEDERA`,
      title: "Agents are entering the market.",
      description: market
        ? "Sellers list scarce items at a floor price. Your scoped agents compete against mocked rival buyers using ledger-capped wallets."
        : "Each agent gets a fresh on-chain wallet holding exactly its mandate cap — it cannot overspend.",
      status: `${yourAgents.length}/${searches.length} wallets live`,
    },
    bidding: {
      eyebrow: market
        ? "ASCENDING AUCTIONS · ON-CHAIN"
        : "LIVE REVERSE AUCTIONS · ON-CHAIN",
      title: market
        ? "Buyers are competing for scarce items."
        : "Sellers are undercutting each other.",
      description: market
        ? "The seller price is the floor; authenticated buyer-agent bids are the only thing that raises it."
        : "Every accepted bid is bound to the registered seller payer. Each agent closes its auction when bidding goes quiet.",
      status: `${totalBids} bids on-chain`,
    },
    complete: {
      eyebrow: market
        ? `MARKET CLOSED · WON ${wonCount}/${searches.length} ON HEDERA`
        : "BUNDLE SETTLED ON HEDERA",
      title: result.plan.occasionTitle,
      description: `${result.plan.location} · ${result.plan.scheduledFor}`,
      status: "On-chain",
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
          resolvedCount={yourAgents.length}
        />
      ) : phase === "bidding" ? (
        market ? (
          <MarketBidStage searches={searches} live={live} />
        ) : (
          <LiveBidStage searches={searches} live={live} />
        )
      ) : (
        <BundleGrid
          searches={searches}
          result={result}
          lostCategories={live.lostCategories}
          agentAccounts={yourAgents}
        />
      )}
    </section>
  );
}

function shortAccount(accountId: string): string {
  return accountId.length > 12
    ? `…${accountId.slice(-7)}`
    : accountId;
}

function MarketBidStage({
  searches,
  live,
}: {
  searches: MockAgentSearch[];
  live: LiveAuctionView;
}) {
  const categories = new Set(
    searches.map((search) => search.allocation.category),
  );
  const visible = live.listings.filter((listing) =>
    categories.has(listing.category as Category),
  );

  return (
    <div className={styles.liveGrid}>
      {visible.map((listing) => {
        const bids = live.bidsByItem[listing.itemId] ?? [];
        const high = bids.reduce<(typeof bids)[number] | undefined>(
          (best, bid) =>
            !best ||
            bid.amountCents > best.amountCents ||
            (bid.amountCents === best.amountCents &&
              bid.sequenceNumber < best.sequenceNumber)
              ? bid
              : best,
          undefined,
        );
        const recent = [...bids]
          .sort(
            (left, right) =>
              right.sequenceNumber - left.sequenceNumber,
          )
          .slice(0, 5);
        const CategoryIcon =
          categoryIcons[listing.category as Category];
        const badge = listing.sold
          ? high?.yours
            ? "Sold to you"
            : "Sold"
          : high?.yours
            ? "You lead"
            : high
              ? "Rival leads"
              : "At floor";

        return (
          <article
            key={listing.itemId}
            className={styles.livePanel}
            data-settled={listing.sold || undefined}
          >
            <header>
              <span>
                <CategoryIcon size={13} aria-hidden="true" />
                {listing.sellerName}
              </span>
              <b>{badge}</b>
            </header>
            <div className={styles.liveBest}>
              <span>Floor {formatUsd(listing.floorCents)}</span>
              <strong>
                {formatUsd(high?.amountCents ?? listing.floorCents)}
              </strong>
              <small>{listing.offering}</small>
            </div>
            <ul className={styles.liveFeed}>
              {recent.map((bid, index) => (
                <li
                  key={bid.sequenceNumber}
                  className={
                    index === 0 ? styles.liveNewest : undefined
                  }
                >
                  <span>
                    {bid.yours
                      ? "your agent"
                      : `rival ${shortAccount(bid.bidder)}`}
                  </span>
                  <b>{formatUsd(bid.amountCents)}</b>
                </li>
              ))}
              {recent.length === 0 && (
                <li>
                  <span>No bids yet — the floor stands</span>
                </li>
              )}
            </ul>
            <footer>
              {(() => {
                const yourAgent = live.agents.find(
                  (agent) =>
                    agent.buyerName === "You" &&
                    agent.category === listing.category,
                );
                return yourAgent ? (
                  <a
                    href={`https://hashscan.io/testnet/account/${yourAgent.accountId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    your agent {yourAgent.accountId}
                  </a>
                ) : (
                  <span>{listing.category}</span>
                );
              })()}
              <a
                href={`https://hashscan.io/testnet/topic/${listing.topicId}`}
                target="_blank"
                rel="noreferrer"
              >
                HCS topic
                <ExternalLink size={9} aria-hidden="true" />
              </a>
            </footer>
          </article>
        );
      })}
    </div>
  );
}

function LiveBidStage({
  searches,
  live,
}: {
  searches: MockAgentSearch[];
  live: LiveAuctionView;
}) {
  return (
    <div className={styles.liveGrid}>
      {searches.map((search) => {
        const category = search.allocation.category;
        const bids = live.bidsByCategory[category] ?? [];
        const agent = live.agents.find((item) => item.category === category);
        const auction = live.auctions.find(
          (item) => item.category === category,
        );
        const settled = live.settledCategories.includes(category);
        const best = bids.reduce<
          (typeof bids)[number] | undefined
        >(
          (lowest, bid) =>
            lowest === undefined || bid.amountCents < lowest.amountCents
              ? bid
              : lowest,
          undefined,
        );
        const recent = [...bids]
          .sort((left, right) => right.sequenceNumber - left.sequenceNumber)
          .slice(0, 5);
        const CategoryIcon = categoryIcons[category];

        return (
          <article
            key={search.id}
            className={styles.livePanel}
            data-settled={settled || undefined}
          >
            <header>
              <span>
                <CategoryIcon size={13} aria-hidden="true" />
                {category}
              </span>
              <b>{settled ? "Settled" : "Live"}</b>
            </header>

            <div className={styles.liveBest}>
              <span>Best offer</span>
              <strong>
                {best ? formatUsd(best.amountCents) : "—"}
              </strong>
              <small>{best?.sellerName ?? "Waiting for sellers…"}</small>
            </div>

            <ul className={styles.liveFeed}>
              {recent.map((bid, index) => (
                <li
                  key={bid.sequenceNumber}
                  className={index === 0 ? styles.liveNewest : undefined}
                >
                  <span>{bid.sellerName}</span>
                  <b>{formatUsd(bid.amountCents)}</b>
                </li>
              ))}
              {recent.length === 0 && (
                <li>
                  <span>Sellers reviewing the mandate…</span>
                </li>
              )}
            </ul>

            <footer>
              <span>
                agent{" "}
                {agent ? (
                  <a
                    href={`https://hashscan.io/testnet/account/${agent.accountId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {agent.accountId}
                  </a>
                ) : (
                  "…"
                )}
              </span>
              {auction && (
                <a
                  href={`https://hashscan.io/testnet/topic/${auction.topicId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  HCS topic
                  <ExternalLink size={9} aria-hidden="true" />
                </a>
              )}
            </footer>
          </article>
        );
      })}
    </div>
  );
}

function AgentSearchRun({
  result,
  searches,
  replays,
  frames,
  onReplay,
}: {
  result: DemoResult;
  searches: MockAgentSearch[];
  replays: MockAuctionReplay[];
  frames: ReplayFrame[];
  onReplay: () => void;
}) {
  const [phase, setPhase] = useState<"replaying" | "complete">("replaying");
  const [currentFrameIndex, setCurrentFrameIndex] = useState(-1);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const completionTimer = window.setTimeout(() => {
        setCurrentFrameIndex(frames.length - 1);
        setPhase("complete");
      }, 0);
      return () => window.clearTimeout(completionTimer);
    }

    const frameDuration = Math.max(
      55,
      Math.min(180, Math.floor(5_200 / Math.max(1, frames.length))),
    );
    const startDelay = 360;
    const timers = frames.map((_, index) =>
      window.setTimeout(
        () => setCurrentFrameIndex(index),
        startDelay + index * frameDuration,
      ),
    );
    const completionTimer = window.setTimeout(
      () => setPhase("complete"),
      startDelay + frames.length * frameDuration + 650,
    );

    return () => {
      timers.forEach(window.clearTimeout);
      window.clearTimeout(completionTimer);
    };
  }, [frames]);

  return (
    <section className={styles.experience} aria-live="polite">
      <header className={styles.heading}>
        <div>
          <span>LOCAL MOCK MARKET · RECORDED EXECUTION</span>
          <h2>
            {phase === "replaying"
              ? "Replaying the exact English-auction trace."
              : "Mock purchase bundle assembled."}
          </h2>
          <p>
            {phase === "replaying"
              ? "The verified 0G plan above is frozen. This animation only " +
                "plays back the deterministic trace already returned by the local market."
              : `${result.plan.occasionTitle} · ${result.plan.location} · ${result.plan.scheduledFor}`}
          </p>
        </div>
        <div className={styles.phasePill}>
          <i className={phase === "complete" ? styles.completeDot : ""} />
          {phase === "replaying" ? "Mock trace replay" : "Replay complete"}
        </div>
      </header>

      {phase === "replaying" ? (
        <ReplayWorkspace
          searches={searches}
          replays={replays}
          frames={frames}
          currentFrameIndex={currentFrameIndex}
        />
      ) : (
        <>
          <BundleGrid searches={searches} result={result} />
          <button
            className={styles.replayButton}
            type="button"
            onClick={onReplay}
          >
            <RotateCcw size={13} />
            Replay recorded mock trace
          </button>
        </>
      )}
    </section>
  );
}

function ReplayWorkspace({
  searches,
  replays,
  frames,
  currentFrameIndex,
}: {
  searches: MockAgentSearch[];
  replays: MockAuctionReplay[];
  frames: ReplayFrame[];
  currentFrameIndex: number;
}) {
  const safeFrameIndex = Math.max(0, currentFrameIndex);
  const activeFrame = frames[safeFrameIndex] ?? {
    replayIndex: 0,
    stepIndex: null,
  };
  const activeReplay = replays[activeFrame.replayIndex] ?? replays[0];

  if (!activeReplay) {
    return (
      <p className={styles.emptyTrace}>
        The mocked market returned no listing-auction traces.
      </p>
    );
  }

  const step =
    activeFrame.stepIndex === null
      ? null
      : (activeReplay.listingAuction.steps[activeFrame.stepIndex] ?? null);
  const replayDone =
    currentFrameIndex >=
    lastFrameForReplay(frames, activeFrame.replayIndex);
  const progress =
    frames.length === 0
      ? 100
      : Math.max(
          0,
          Math.round(((currentFrameIndex + 1) / frames.length) * 100),
        );

  return (
    <div className={styles.replayLayout}>
      <BuyerLedger
        searches={searches}
        replays={replays}
        frames={frames}
        currentFrameIndex={currentFrameIndex}
      />

      <div className={styles.auctionStage}>
        <div className={styles.stageHeader}>
          <div>
            <span>
              <Gavel size={12} />
              MOCK ENGLISH AUCTION REPLAY
            </span>
            <strong>
              Listing {activeFrame.replayIndex + 1} of {replays.length}
            </strong>
          </div>
          <div className={styles.progressCopy}>
            <span>{progress}%</span>
            <small>stored trace</small>
          </div>
        </div>
        <div className={styles.progressTrack}>
          <i style={{ width: `${progress}%` }} />
        </div>

        <ListingHeader
          replay={activeReplay}
          step={step}
          replayDone={replayDone}
        />

        <div className={styles.stageGrid}>
          <ParticipantList replay={activeReplay} step={step} />
          <PriceStepFeed
            replays={replays}
            frames={frames}
            currentFrameIndex={currentFrameIndex}
          />
        </div>
      </div>
    </div>
  );
}

function BuyerLedger({
  searches,
  replays,
  frames,
  currentFrameIndex,
}: {
  searches: MockAgentSearch[];
  replays: MockAuctionReplay[];
  frames: ReplayFrame[];
  currentFrameIndex: number;
}) {
  return (
    <aside className={styles.buyerLedger}>
      <header>
        <span>ALLOCATION BUYERS</span>
        <b>{searches.length} scoped agents</b>
      </header>

      <div className={styles.buyerList}>
        {searches.map((search) => {
          const CategoryIcon = categoryIcons[search.allocation.category];
          const searchReplayIndices = replays.flatMap((replay, index) =>
            replay.search.id === search.id ? [index] : [],
          );
          const firstReplay = searchReplayIndices[0] ?? 0;
          const lastReplay = searchReplayIndices.at(-1) ?? firstReplay;
          const firstFrame = frames.findIndex(
            (frame) => frame.replayIndex === firstReplay,
          );
          const lastFrame = lastFrameForReplay(frames, lastReplay);
          const state =
            currentFrameIndex >= lastFrame
              ? "complete"
              : currentFrameIndex >= firstFrame
                ? "active"
                : "waiting";

          return (
            <article
              key={search.id}
              className={state === "active" ? styles.activeBuyer : ""}
            >
              <span className={styles.buyerIcon}>
                {state === "complete" ? (
                  <Check size={13} />
                ) : (
                  <CategoryIcon size={13} />
                )}
              </span>
              <div>
                <strong>{search.allocation.category}</strong>
                <code>{search.agentId}</code>
                <small>
                  {search.auction.listingAuctions.length} listing
                  {search.auction.listingAuctions.length === 1 ? "" : "s"} ·{" "}
                  {formatUsd(search.allocation.maxBudgetCents)} mandate
                </small>
              </div>
              <b>{state}</b>
            </article>
          );
        })}
      </div>

      <p>
        IDs come from the executed buyer subagents. They are not wallets and no
        keypairs are implied.
      </p>
    </aside>
  );
}

function ListingHeader({
  replay,
  step,
  replayDone,
}: {
  replay: MockAuctionReplay;
  step: EnglishAuctionStep | null;
  replayDone: boolean;
}) {
  const { listingAuction } = replay;
  const CategoryIcon = categoryIcons[replay.search.allocation.category];

  return (
    <article className={styles.listingHeader}>
      <span className={styles.listingIcon}>
        <CategoryIcon size={18} />
      </span>
      <div className={styles.listingCopy}>
        <span>
          {replay.search.allocation.category} · mock seller · attempt{" "}
          {replay.attemptNumber}
        </span>
        <h3>{listingAuction.listing.sellerName}</h3>
        <p>{listingAuction.listing.offering}</p>
        <code>{listingAuction.auctionId}</code>
      </div>
      <dl className={styles.priceFacts}>
        <div>
          <dt>Seller floor</dt>
          <dd>{formatUsd(listingAuction.debugSellerFloorPriceCents)}</dd>
        </div>
        <div>
          <dt>{step ? "Current ask" : "Opening result"}</dt>
          <dd>
            {step
              ? formatUsd(step.askingPriceCents)
              : statusLabel(replay)}
          </dd>
        </div>
        <div>
          <dt>Recorded outcome</dt>
          <dd className={replayDone ? styles.outcomeVisible : ""}>
            {replayDone
              ? `${statusLabel(replay)}${
                  listingAuction.clearingPriceCents === null
                    ? ""
                    : ` · ${formatUsd(listingAuction.clearingPriceCents)}`
                }`
              : "replaying…"}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function ParticipantList({
  replay,
  step,
}: {
  replay: MockAuctionReplay;
  step: EnglishAuctionStep | null;
}) {
  return (
    <section className={styles.participants}>
      <header>
        <div>
          <Users size={12} />
          <span>RECORDED PARTICIPANTS</span>
        </div>
        <small>debug-only valuation caps</small>
      </header>

      <div>
        {replay.listingAuction.participants.map((participant) => {
          const isActive = step?.activeBidderIds.includes(
            participant.bidderId,
          );
          const hasDropped = step?.droppedBidderIds.includes(
            participant.bidderId,
          );
          const isLeader = step?.leadingBidderId === participant.bidderId;

          return (
            <article
              key={participant.bidderId}
              className={`${isLeader ? styles.leader : ""} ${
                hasDropped ? styles.dropped : ""
              }`}
            >
              <span>
                {participant.bidderKind ===
                "allocation-buyer-subagent" ? (
                  <CheckCircle2 size={12} />
                ) : (
                  <Store size={12} />
                )}
              </span>
              <div>
                <code>{participant.bidderId}</code>
                <small>
                  {participant.bidderKind ===
                  "allocation-buyer-subagent"
                    ? "scoped buyer subagent"
                    : "mock rival"}
                </small>
              </div>
              <b>{formatUsd(participant.debugMaxBidCents)}</b>
              <i>
                {isLeader
                  ? "leader"
                  : hasDropped
                    ? "dropped"
                    : isActive
                      ? "active"
                      : "waiting"}
              </i>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PriceStepFeed({
  replays,
  frames,
  currentFrameIndex,
}: {
  replays: MockAuctionReplay[];
  frames: ReplayFrame[];
  currentFrameIndex: number;
}) {
  const firstVisible = Math.max(0, currentFrameIndex - 7);
  const visibleFrames =
    currentFrameIndex < 0
      ? []
      : frames.slice(firstVisible, currentFrameIndex + 1);

  return (
    <section className={styles.stepFeed}>
      <header>
        <div>
          <Clock3 size={12} />
          <span>ASCENDING PRICE STEPS</span>
        </div>
        <small>recorded, not generated by this UI</small>
      </header>

      <ol>
        {visibleFrames.length === 0 ? (
          <li className={styles.preparing}>
            Loading the stored mock trace…
          </li>
        ) : (
          visibleFrames.map((frame, index) => {
            const replay = replays[frame.replayIndex];
            if (!replay) return null;
            const step =
              frame.stepIndex === null
                ? null
                : replay.listingAuction.steps[frame.stepIndex];
            const absoluteIndex = firstVisible + index;

            return (
              <li
                key={`${replay.id}:${frame.stepIndex ?? "floor"}`}
                className={
                  absoluteIndex === currentFrameIndex
                    ? styles.currentStep
                    : ""
                }
              >
                <b>
                  {step ? `#${step.sequence}` : "—"}
                </b>
                <strong>
                  {step
                    ? formatUsd(step.askingPriceCents)
                    : "No opening bid"}
                </strong>
                <span>
                  <code>{replay.listingAuction.listing.sellerName}</code>
                  <small>
                    Lead: {step?.leadingBidderId ?? "none"}
                    {step && step.droppedBidderIds.length > 0
                      ? ` · Dropped: ${step.droppedBidderIds.join(", ")}`
                      : ""}
                  </small>
                </span>
              </li>
            );
          })
        )}
      </ol>
    </section>
  );
}

function BundleGrid({
  searches,
  result,
  lostCategories = [],
  agentAccounts = [],
}: {
  searches: MockAgentSearch[];
  result: DemoResult;
  lostCategories?: string[];
  agentAccounts?: Array<{
    category: string;
    accountId: string;
    buyerName: string;
  }>;
}) {
  return (
    <div className={styles.bundleGrid}>
      {searches.map((search, index) => {
        const receipt = result.receipts.find(
          (candidate) =>
            candidate.category === search.allocation.category,
        );
        const onChain = receipt?.status === "hedera-settled";
        const lost =
          !onChain &&
          lostCategories.includes(search.allocation.category);
        const agentAccountId = agentAccounts.find(
          (agent) =>
            agent.category === search.allocation.category,
        )?.accountId;
        const CategoryIcon = categoryIcons[search.allocation.category];
        const visibleTags =
          search.matchedTags.length > 0
            ? search.matchedTags
            : search.auction.winner.tags.slice(0, 2);

        return (
          <article
            className={styles.resultCard}
            data-category={search.allocation.category}
            key={search.id}
          >
            <div className={styles.resultArt}>
              <CategoryIcon size={28} />
              <b>0{index + 1}</b>
            </div>
            <div className={styles.resultBody}>
              <header>
                <span>{search.allocation.category}</span>
                <b>
                  {lost ? <X size={9} /> : <Check size={9} />}
                  {lost ? "outbid" : onChain ? "on-chain" : "mock win"}
                </b>
              </header>
              <h3>
                {lost ? "No purchase" : search.auction.winner.sellerName}
              </h3>
              <p>
                {lost
                  ? "Rivals pushed every listing beyond this mandate. The agent walked away instead of overspending."
                  : search.auction.winner.offering}
              </p>
              {!lost && (
                <div className={styles.tags}>
                  {visibleTags.slice(0, 3).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              )}
              <div className={styles.resultFooter}>
                <div>
                  <span>
                    {onChain || lost
                      ? "Agent wallet"
                      : "Buyer subagent ID"}
                  </span>
                  {(receipt?.escrowAccountId || agentAccountId) ? (
                    <a
                      href={`https://hashscan.io/testnet/account/${
                        receipt?.escrowAccountId ?? agentAccountId
                      }`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <code>
                        {receipt?.escrowAccountId ?? agentAccountId}
                      </code>
                    </a>
                  ) : (
                    <code>{search.agentId}</code>
                  )}
                </div>
                <strong>
                  {formatUsd(
                    lost
                      ? 0
                      : receipt?.amountCents ??
                          search.auction.winner.amountCents,
                  )}
                </strong>
              </div>
              {onChain && receipt?.hashscanUrl && (
                <div className={styles.onchainLinks}>
                  <a
                    href={receipt.hashscanUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Atomic swap
                    <ExternalLink size={9} aria-hidden="true" />
                  </a>
                  {receipt.claimNftSerial !== undefined &&
                    receipt.escrowAccountId && (
                      <a
                        href={`https://hashscan.io/testnet/account/${receipt.escrowAccountId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Claim NFT #{receipt.claimNftSerial}
                        <ExternalLink size={9} aria-hidden="true" />
                      </a>
                    )}
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
