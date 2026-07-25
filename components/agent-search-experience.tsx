"use client";

import {
  Activity,
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
  Radio,
  Store,
  Trophy,
  Users,
  UtensilsCrossed,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useState,
} from "react";

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
import { marketSettlementFromEvents } from "@/src/hedera/marketEvidence";
import type { LiveAuctionView } from "@/components/use-settlement-job";

import styles from "./agent-search-experience.module.css";

const categoryIcons: Record<Category, LucideIcon> = {
  flowers: Flower2,
  cinema: Clapperboard,
  dinner: UtensilsCrossed,
  transport: CarFront,
  experience: Palette,
};

const WON_AUCTION_HOLD_MS = 2_500;

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
  const searches = useMemo(
    () => createMockAgentSearches(result),
    // Settlement swaps mock receipts for Hedera receipts on the same plan.
    // Keep the replay snapshot stable across that receipt-only update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
 * Wallets appear as the swarm funds them, the bidding stage streams the
 * payer-authenticated HCS lifecycle from Mirror Node, and the result cards
 * carry the on-chain receipts.
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
    <section
      className={`${styles.experience} ${
        phase === "complete" ? styles.bundleComplete : ""
      }`}
      aria-live="polite"
    >
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

function hashscanTransactionUrl(transactionId: string): string {
  const [payer, timestamp] = transactionId.split("@");
  return timestamp
    ? `https://hashscan.io/testnet/transaction/${payer}-${timestamp.replace(".", "-")}`
    : `https://hashscan.io/testnet/transaction/${transactionId}`;
}

function ActivityDiscovery({
  searches,
  resolvedCount,
}: {
  searches: MockAgentSearch[];
  resolvedCount: number;
}) {
  return (
    <>
      <div className={styles.orbitScene}>
        <div className={styles.dreamWash} />
        <div className={styles.orbitLine} />
        <div className={styles.core}>
          <Users size={18} aria-hidden="true" />
          <strong>{resolvedCount}</strong>
          <span>WALLETS LIVE</span>
        </div>
        {searches.map((search, index) => {
          const CategoryIcon = categoryIcons[search.allocation.category];
          const found = index < resolvedCount;
          return (
            <div
              className={styles.orbitSlot}
              key={search.id}
              style={
                {
                  "--agent-delay": `${-(index * 9) / searches.length}s`,
                } as CSSProperties
              }
            >
              <div className={styles.orbitTraveller}>
                <article
                  className={`${styles.orbitCard} ${
                    found ? styles.found : ""
                  }`}
                >
                  <header>
                    <span>
                      <CategoryIcon size={13} aria-hidden="true" />
                    </span>
                    <b>
                      {found ? <Check size={10} /> : <Clock3 size={10} />}
                      {found ? "funded" : "creating"}
                    </b>
                  </header>
                  <h3>{search.allocation.category} agent</h3>
                  <code>{search.agentId}</code>
                  <footer>
                    {formatUsd(search.allocation.maxBudgetCents)} mandate
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
            <span
              className={index < resolvedCount ? styles.ledgerFound : ""}
            >
              {index < resolvedCount ? <Check size={10} /> : index + 1}
            </span>
            <div>
              <strong>{search.allocation.category}</strong>
              <code>{search.agentId}</code>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

type MarketListing = LiveAuctionView["listings"][number];
type MarketBid = LiveAuctionView["bidsByItem"][string][number];
type MarketEvent =
  LiveAuctionView["ledgerEventsByItem"][string][number];
type MarketVisualState =
  | "scanning"
  | "live"
  | "leading"
  | "outbid"
  | "won"
  | "sold"
  | "lost";

function highestMarketBid(bids: MarketBid[]): MarketBid | undefined {
  return bids.reduce<MarketBid | undefined>(
    (best, bid) =>
      !best ||
      bid.amountCents > best.amountCents ||
      (bid.amountCents === best.amountCents &&
        bid.sequenceNumber < best.sequenceNumber)
        ? bid
        : best,
    undefined,
  );
}

function latestMarketSequence(
  messages: Array<{ sequenceNumber: number }>,
): number {
  return messages.reduce(
    (latest, message) => Math.max(latest, message.sequenceNumber),
    0,
  );
}

function listingVisualState(
  listing: MarketListing,
  bids: MarketBid[],
  events: MarketEvent[],
): MarketVisualState {
  const settlement = marketSettlementFromEvents(events);
  const high = highestMarketBid(bids);
  if (settlement) return settlement.yours ? "won" : "sold";
  if (listing.sold) return "sold";
  if (high?.yours) return "leading";
  if (bids.some((bid) => bid.yours)) return "outbid";
  return bids.length > 0 ? "live" : "scanning";
}

function marketStateLabel(state: MarketVisualState): string {
  switch (state) {
    case "leading":
      return "You lead";
    case "outbid":
      return "Outbid";
    case "won":
      return "Swap confirmed";
    case "sold":
      return "Settled";
    case "lost":
      return "Agent walked away";
    case "live":
      return "Bids incoming";
    default:
      return "Scanning";
  }
}

function MarketBidStage({
  searches,
  live,
}: {
  searches: MockAgentSearch[];
  live: LiveAuctionView;
}) {
  const categories = useMemo(
    () => searches.map((search) => search.allocation.category),
    [searches],
  );
  const categorySet = useMemo(() => new Set(categories), [categories]);
  const visible = useMemo(
    () =>
      live.listings.filter((listing) =>
        categorySet.has(listing.category as Category),
      ),
    [categorySet, live.listings],
  );
  const [pinnedCategory, setPinnedCategory] = useState<Category | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const followedCategory = useMemo(
    () =>
      [...categories].sort((left, right) => {
        const activityScore = (category: Category) => {
          const bids = visible
            .filter((listing) => listing.category === category)
            .flatMap(
              (listing) => live.bidsByItem[listing.itemId] ?? [],
            );
          const leading = visible.some((listing) => {
            if (listing.category !== category) return false;
            return (
              listingVisualState(
                listing,
                live.bidsByItem[listing.itemId] ?? [],
                live.ledgerEventsByItem[listing.itemId] ?? [],
              ) === "leading"
            );
          });
          return (
            (leading ? 1_000_000 : 0) +
            (bids.some((bid) => bid.yours) ? 100_000 : 0) +
            bids.length
          );
        };
        return activityScore(right) - activityScore(left);
      })[0],
    [
      categories,
      live.bidsByItem,
      live.ledgerEventsByItem,
      visible,
    ],
  );

  const activeCategory =
    pinnedCategory && categorySet.has(pinnedCategory)
      ? pinnedCategory
      : followedCategory;
  const activeListings = visible.filter(
    (listing) => listing.category === activeCategory,
  );

  const automaticFocus = [...activeListings].sort((left, right) => {
    const score = (listing: MarketListing) => {
      const bids = live.bidsByItem[listing.itemId] ?? [];
      const events = live.ledgerEventsByItem[listing.itemId] ?? [];
      const state = listingVisualState(listing, bids, events);
      const stateWeight: Record<MarketVisualState, number> = {
        won: 7,
        leading: 6,
        outbid: 5,
        live: 4,
        scanning: 3,
        sold: 2,
        lost: 1,
      };
      return (
        stateWeight[state] * 1_000_000 +
        latestMarketSequence(events)
      );
    };
    return score(right) - score(left);
  })[0];
  const selectedFocus = activeListings.find(
    (listing) => listing.itemId === selectedItemId,
  );
  const focus = selectedFocus ?? automaticFocus;

  const focusBids = focus
    ? (live.bidsByItem[focus.itemId] ?? [])
    : [];
  const focusEvents = focus
    ? (live.ledgerEventsByItem[focus.itemId] ?? [])
    : [];
  const focusHigh = highestMarketBid(focusBids);
  const focusSettlement = marketSettlementFromEvents(focusEvents);
  const focusState =
    activeCategory && live.lostCategories.includes(activeCategory)
      ? "lost"
      : focus
        ? listingVisualState(focus, focusBids, focusEvents)
        : "scanning";
  const recentFocusEvents = [...focusEvents]
    .sort(
      (left, right) =>
        right.sequenceNumber - left.sequenceNumber,
    )
    .slice(0, 7);
  const focusSearch = searches.find(
    (search) => search.allocation.category === activeCategory,
  );
  const focusAgent = live.agents.find(
    (agent) =>
      agent.buyerName === "You" &&
      agent.category === activeCategory,
  );
  const initialFocusCap =
    focusAgent?.initialCapCents ??
    focusSearch?.allocation.maxBudgetCents ??
    0;
  const focusGranted = focusAgent?.grantedCents ?? 0;
  const focusCap =
    focusAgent?.effectiveCapCents ??
    initialFocusCap + focusGranted;
  const focusGrantTransaction =
    focusAgent?.grantTransactions?.at(-1);
  const currentPrice = focus
    ? (focusSettlement?.amountCents ??
      focusHigh?.amountCents ??
      focus.floorCents)
    : 0;
  const priceProgress =
    focus && focusCap > focus.floorCents
      ? Math.max(
          0,
          Math.min(
            100,
            ((currentPrice - focus.floorCents) /
              (focusCap - focus.floorCents)) *
              100,
          ),
        )
      : 0;
  const yourLastBid = [...focusBids]
    .reverse()
    .find((bid) => bid.yours);
  const totalBids = Object.values(live.bidsByItem).reduce(
    (sum, bids) => sum + bids.length,
    0,
  );
  const settledCount = new Set([
    ...live.settledCategories,
    ...live.lostCategories,
  ]).size;
  const otherListings = activeListings.filter(
    (listing) => listing.itemId !== focus?.itemId,
  );

  function categoryState(category: Category): MarketVisualState {
    if (live.lostCategories.includes(category)) return "lost";
    if (live.settledCategories.includes(category)) return "won";
    const listings = visible.filter(
      (listing) => listing.category === category,
    );
    const states = listings.map((listing) =>
      listingVisualState(
        listing,
        live.bidsByItem[listing.itemId] ?? [],
        live.ledgerEventsByItem[listing.itemId] ?? [],
      ),
    );
    if (states.includes("leading")) return "leading";
    if (states.includes("outbid")) return "outbid";
    if (states.includes("live")) return "live";
    return "scanning";
  }

  return (
    <section className={styles.marketCockpit}>
      <div className={styles.chainPulse}>
        <div className={styles.chainPulseTitle}>
          <span>
            <Radio size={14} aria-hidden="true" />
          </span>
          <div>
            <small>HEDERA TESTNET · LIVE MARKET</small>
            <strong>Authenticated activity, as it lands on-chain.</strong>
          </div>
        </div>
        <dl>
          <div>
            <dt>HCS topics</dt>
            <dd>{visible.length}</dd>
          </div>
          <div>
            <dt>Bid messages</dt>
            <dd>{totalBids}</dd>
          </div>
          <div>
            <dt>Wallets live</dt>
            <dd>{live.agents.length}</dd>
          </div>
          <div>
            <dt>Agents resolved</dt>
            <dd>
              {settledCount}/{searches.length}
            </dd>
          </div>
        </dl>
      </div>

      <nav
        className={styles.marketAgentRail}
        aria-label="Choose an allocation buyer agent"
      >
        {categories.map((category) => {
          const search = searches.find(
            (candidate) =>
              candidate.allocation.category === category,
          );
          const agent = live.agents.find(
            (candidate) =>
              candidate.buyerName === "You" &&
              candidate.category === category,
          );
          const state = categoryState(category);
          const CategoryIcon = categoryIcons[category];
          const active = category === activeCategory;
          const initialCap =
            agent?.initialCapCents ??
            search?.allocation.maxBudgetCents ??
            0;
          const granted = agent?.grantedCents ?? 0;
          const effectiveCap =
            agent?.effectiveCapCents ?? initialCap + granted;

          return (
            <button
              type="button"
              key={category}
              className={active ? styles.marketAgentActive : ""}
              data-state={state}
              aria-pressed={active}
              onClick={() => {
                setPinnedCategory(category);
                setSelectedItemId(null);
              }}
            >
              <span className={styles.marketAgentIcon}>
                {state === "won" ? (
                  <Trophy size={14} aria-hidden="true" />
                ) : (
                  <CategoryIcon size={14} aria-hidden="true" />
                )}
              </span>
              <span>
                <small>{marketStateLabel(state)}</small>
                <strong>{category}</strong>
                <code>
                  {agent
                    ? shortAccount(agent.accountId)
                    : "wallet funding…"}
                </code>
              </span>
              <span
                className={styles.marketAgentCap}
                title={
                  granted > 0
                    ? `${formatUsd(initialCap)} initial mandate plus ${formatUsd(granted)} on-chain contingency`
                    : `${formatUsd(initialCap)} funded mandate`
                }
              >
                <b>{formatUsd(effectiveCap)}</b>
                {granted > 0 && (
                  <small>+{formatUsd(granted)} grant</small>
                )}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          className={styles.liveFollowButton}
          data-following={!pinnedCategory || undefined}
          onClick={() => {
            setPinnedCategory(null);
            setSelectedItemId(null);
          }}
        >
          <Activity size={13} aria-hidden="true" />
          {pinnedCategory ? "Follow market pulse" : "Following market pulse"}
        </button>
      </nav>

      {focus ? (
        <>
          <div className={styles.marketFocus}>
            <article
              className={styles.focusAuction}
              data-state={focusState}
              aria-live="polite"
            >
              <header>
                <div>
                  <span>
                    <Gavel size={13} aria-hidden="true" />
                    {activeCategory} auction · HCS live
                  </span>
                  <code>{focus.itemId}</code>
                </div>
                <b>{marketStateLabel(focusState)}</b>
              </header>

              <div className={styles.focusIdentity}>
                <span className={styles.focusIcon}>
                  {(() => {
                    const CategoryIcon =
                      categoryIcons[activeCategory ?? "experience"];
                    return <CategoryIcon size={24} aria-hidden="true" />;
                  })()}
                </span>
                <div>
                  <small>{focus.sellerName}</small>
                  <h3>{focus.offering}</h3>
                </div>
              </div>

              <div className={styles.focusPrice}>
                <span>
                  {focusSettlement
                    ? "Final clearing price"
                    : focus.sold
                      ? "Settlement indexing"
                      : "Highest bid"}
                </span>
                <strong>{formatUsd(currentPrice)}</strong>
                <small>
                  {focusBids.length} authenticated HCS bid
                  {focusBids.length === 1 ? "" : "s"}
                </small>
              </div>

              <div className={styles.priceRange}>
                <div>
                  <span>Seller floor</span>
                  <strong>{formatUsd(focus.floorCents)}</strong>
                </div>
                <div className={styles.priceRail}>
                  <i style={{ width: `${priceProgress}%` }} />
                  <b style={{ left: `${priceProgress}%` }} />
                </div>
                <div>
                  <span>
                    {focusGranted > 0
                      ? "Effective cap"
                      : "Agent mandate"}
                  </span>
                  <strong>{formatUsd(focusCap)}</strong>
                  {focusGranted > 0 && (
                    <small>
                      {formatUsd(initialFocusCap)} initial · +
                      {formatUsd(focusGranted)} contingency
                    </small>
                  )}
                </div>
              </div>

              <div className={styles.agentPosition}>
                <span>
                  <WalletCards size={15} aria-hidden="true" />
                </span>
                <div>
                  <small>YOUR SCOPED AGENT</small>
                  <strong>
                    {focusAgent?.accountId ?? "Wallet is funding…"}
                  </strong>
                </div>
                <div>
                  <small>LAST BID</small>
                  <strong>
                    {yourLastBid
                      ? formatUsd(yourLastBid.amountCents)
                      : "Watching"}
                  </strong>
                </div>
              </div>

              {focusSettlement?.yours && (
                <div className={styles.focusSettlement}>
                  <span>
                    <Check size={15} aria-hidden="true" />
                  </span>
                  <div>
                    <small>ATOMIC HTS SWAP CONFIRMED</small>
                    <strong>
                      NATA payment sent · claim NFT received
                    </strong>
                    <code>{focusSettlement.transactionId}</code>
                  </div>
                  <b>{formatUsd(focusSettlement.amountCents)}</b>
                </div>
              )}

              <footer className={styles.focusChainLinks}>
                {focusAgent && (
                  <a
                    href={`https://hashscan.io/testnet/account/${focusAgent.accountId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <WalletCards size={12} aria-hidden="true" />
                    Agent wallet
                    <ExternalLink size={9} aria-hidden="true" />
                  </a>
                )}
                <a
                  href={`https://hashscan.io/testnet/topic/${focus.topicId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Radio size={12} aria-hidden="true" />
                  Live HCS topic
                  <ExternalLink size={9} aria-hidden="true" />
                </a>
                {focusSettlement && (
                  <a
                    href={hashscanTransactionUrl(
                      focusSettlement.transactionId,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Check size={12} aria-hidden="true" />
                    Atomic swap
                    <ExternalLink size={9} aria-hidden="true" />
                  </a>
                )}
                {focusGrantTransaction && (
                  <a
                    href={hashscanTransactionUrl(
                      focusGrantTransaction.transactionId,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <WalletCards size={12} aria-hidden="true" />
                    Budget grant
                    <ExternalLink size={9} aria-hidden="true" />
                  </a>
                )}
                <span>
                  Bids match their payer; lifecycle events match clearing.
                </span>
              </footer>
            </article>

            <aside className={styles.marketActivity}>
              <header>
                <div>
                  <Activity size={13} aria-hidden="true" />
                  <span>LEDGER ACTIVITY</span>
                </div>
                <b>
                  <i />
                  LIVE
                </b>
              </header>
              <ol>
                {recentFocusEvents.map((event, index) => {
                  const yours =
                    "yours" in event && event.yours;
                  const amount =
                    "amountCents" in event
                      ? event.amountCents
                      : undefined;
                  const title =
                    event.type === "LISTED"
                      ? "Clearing opened the listing"
                      : event.type === "CLOSED"
                        ? "Clearing closed bidding"
                        : event.type === "FORFEITED"
                          ? yours
                            ? "Your claim window expired"
                            : `Bidder ${shortAccount(event.bidder)} forfeited`
                          : event.type === "SETTLED"
                            ? yours
                              ? "Your atomic swap settled"
                              : `Bidder ${shortAccount(event.bidder)} settled`
                            : yours
                              ? "Your agent placed a bid"
                              : `Rival ${shortAccount(event.bidder)} raised`;
                  const detail =
                    event.type === "SETTLED"
                      ? event.transactionId
                      : "bidder" in event
                        ? event.bidder
                        : event.payerAccountId;

                  return (
                    <li
                      key={event.sequenceNumber}
                      className={
                        yours ? styles.yourMarketEvent : ""
                      }
                      data-kind={event.type.toLowerCase()}
                      data-newest={index === 0 || undefined}
                    >
                      <span>
                        {event.type === "SETTLED" ? (
                          <CheckCircle2 size={11} aria-hidden="true" />
                        ) : event.type === "FORFEITED" ? (
                          <X size={11} aria-hidden="true" />
                        ) : event.type === "CLOSED" ? (
                          <Gavel size={11} aria-hidden="true" />
                        ) : event.type === "LISTED" ? (
                          <Radio size={11} aria-hidden="true" />
                        ) : yours ? (
                          <Check size={11} aria-hidden="true" />
                        ) : (
                          <Store size={11} aria-hidden="true" />
                        )}
                      </span>
                      <div>
                        <small>
                          HCS {event.type} #{event.sequenceNumber}
                        </small>
                        <strong>{title}</strong>
                        <code>{detail}</code>
                      </div>
                      {amount !== undefined && (
                        <b>{formatUsd(amount)}</b>
                      )}
                    </li>
                  );
                })}
                {recentFocusEvents.length === 0 && (
                  <li className={styles.awaitingBid}>
                    <span>
                      <Clock3 size={12} aria-hidden="true" />
                    </span>
                    <div>
                      <small>TOPIC OPEN</small>
                      <strong>Waiting for authenticated HCS evidence</strong>
                      <code>{focus.topicId}</code>
                    </div>
                  </li>
                )}
              </ol>
              <footer>
                <span>
                  Latest {Math.min(7, recentFocusEvents.length)} of{" "}
                  {focusEvents.length} authenticated events
                </span>
                <a
                  href={`https://hashscan.io/testnet/topic/${focus.topicId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Inspect full log
                  <ExternalLink size={9} aria-hidden="true" />
                </a>
              </footer>
            </aside>
          </div>

          <section className={styles.marketListings}>
            <header>
              <div>
                <span>OTHER {activeCategory} INVENTORY</span>
                <strong>
                  {activeListings.length} scarce listing
                  {activeListings.length === 1 ? "" : "s"} on separate
                  HCS topics
                </strong>
              </div>
              <small>
                Select a listing to pin its live ledger activity
              </small>
            </header>
            <div>
              {otherListings.map((listing) => {
                const bids = live.bidsByItem[listing.itemId] ?? [];
                const events =
                  live.ledgerEventsByItem[listing.itemId] ?? [];
                const high = highestMarketBid(bids);
                const settlement =
                  marketSettlementFromEvents(events);
                const state = listingVisualState(
                  listing,
                  bids,
                  events,
                );
                return (
                  <button
                    type="button"
                    key={listing.itemId}
                    data-state={state}
                    onClick={() => setSelectedItemId(listing.itemId)}
                  >
                    <span>
                      <Store size={12} aria-hidden="true" />
                    </span>
                    <div>
                      <small>
                        {listing.sellerName}
                        {listing.humanPolicy === "one-per-human" && (
                          <i className={styles.humanGate} title="One allocation per verified human (World ID)">
                            1/human
                          </i>
                        )}
                      </small>
                      <strong>{listing.offering}</strong>
                    </div>
                    <div>
                      <small>{marketStateLabel(state)}</small>
                      <strong>
                        {formatUsd(
                          settlement?.amountCents ??
                            high?.amountCents ??
                            listing.floorCents,
                        )}
                      </strong>
                    </div>
                    <b>{bids.length} HCS</b>
                  </button>
                );
              })}
              {otherListings.length === 0 && (
                <p>This is the only listing in the selected category.</p>
              )}
            </div>
          </section>
        </>
      ) : (
        <div className={styles.marketWaiting}>
          <Clock3 size={18} aria-hidden="true" />
          <strong>Opening authenticated HCS auction topics…</strong>
          <span>The first scarce listing will appear here.</span>
        </div>
      )}
    </section>
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
    let elapsed = startDelay;
    const timers = frames.map((frame, index) => {
      const timer = window.setTimeout(
        () => setCurrentFrameIndex(index),
        elapsed,
      );
      const closesReplay =
        frames[index + 1]?.replayIndex !== frame.replayIndex;
      elapsed += frameDuration;
      if (
        closesReplay &&
        replays[frame.replayIndex]?.listingAuction.status === "won"
      ) {
        elapsed += WON_AUCTION_HOLD_MS;
      }
      return timer;
    });
    const completionTimer = window.setTimeout(
      () => setPhase("complete"),
      elapsed + 650,
    );

    return () => {
      timers.forEach(window.clearTimeout);
      window.clearTimeout(completionTimer);
    };
  }, [frames, replays]);

  return (
    <section
      className={`${styles.experience} ${
        phase === "complete" ? styles.bundleComplete : ""
      }`}
      aria-live="polite"
    >
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
  const wonAuctionResolved =
    replayDone && activeReplay.listingAuction.status === "won";
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

      <div
        className={`${styles.auctionStage} ${
          wonAuctionResolved ? styles.auctionStageWon : ""
        }`}
      >
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

        {wonAuctionResolved && (
          <div className={styles.replayWinReceipt} role="status">
            <span className={styles.winCheck}>
              <Check size={15} aria-hidden="true" />
            </span>
            <div>
              <small>AUCTION WON · ACTIVITY SECURED</small>
              <strong>
                {activeReplay.listingAuction.listing.offering}
              </strong>
              <code>
                {activeReplay.listingAuction.listing.sellerName} ·{" "}
                {activeReplay.search.agentId}
              </code>
            </div>
            <b>
              {formatUsd(
                activeReplay.listingAuction.clearingPriceCents ?? 0,
              )}
            </b>
          </div>
        )}

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
  agentAccounts?: LiveAuctionView["agents"];
}) {
  const isLost = (search: MockAgentSearch) =>
    !result.receipts.some(
      (receipt) =>
        receipt.category === search.allocation.category &&
        receipt.status === "hedera-settled",
    ) && lostCategories.includes(search.allocation.category);
  const securedCount = searches.filter((search) => !isLost(search)).length;
  const totalSettledCents = searches.reduce((total, search) => {
    if (isLost(search)) return total;
    const receipt = result.receipts.find(
      (candidate) =>
        candidate.category === search.allocation.category,
    );
    return total + (receipt?.amountCents ?? search.auction.winner.amountCents);
  }, 0);
  const hasOnChainReceipts = result.receipts.some(
    (receipt) => receipt.status === "hedera-settled",
  );

  return (
    <>
      <div className={styles.bundleSummary}>
        <span>
          <Check size={18} strokeWidth={2.7} aria-hidden="true" />
        </span>
        <div>
          <small>
            {hasOnChainReceipts
              ? "HEDERA SETTLEMENT COMPLETE"
              : "MOCK AUCTIONS COMPLETE"}
          </small>
          <strong>
            {securedCount} of {searches.length} activities secured
          </strong>
        </div>
        <div>
          <small>TOTAL SETTLED</small>
          <strong>{formatUsd(totalSettledCents)}</strong>
        </div>
      </div>

      <div className={styles.bundleGrid}>
        {searches.map((search, index) => {
        const receipt = result.receipts.find(
          (candidate) =>
            candidate.category === search.allocation.category,
        );
        const onChain = receipt?.status === "hedera-settled";
        const lost = isLost(search);
        const agent = agentAccounts.find(
          (agent) =>
            agent.category === search.allocation.category,
        );
        const agentAccountId = agent?.accountId;
        const grantTransaction = agent?.grantTransactions?.at(-1);
        const CategoryIcon = categoryIcons[search.allocation.category];
        const visibleTags =
          search.matchedTags.length > 0
            ? search.matchedTags
            : search.auction.winner.tags.slice(0, 2);

        return (
          <article
            className={styles.resultCard}
            data-category={search.allocation.category}
            data-lost={lost || undefined}
            key={search.id}
          >
            <div className={styles.resultCardHeader}>
              <div className={styles.resultArt}>
                <CategoryIcon size={24} aria-hidden="true" />
              </div>
              <div className={styles.resultCategory}>
                <small>ACTIVITY 0{index + 1}</small>
                <strong>{search.allocation.category}</strong>
              </div>
              <span className={styles.resultMatched}>
                {lost ? <X size={11} /> : <Check size={11} />}
                {lost ? "Outbid" : onChain ? "On-chain" : "Secured"}
              </span>
            </div>
            <div className={styles.resultBody}>
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
                  {receipt.auctionTopicUrl && (
                    <a
                      href={receipt.auctionTopicUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      HCS auction proof
                      <ExternalLink size={9} aria-hidden="true" />
                      </a>
                    )}
                  {receipt.liveGrantedCents !== undefined && (
                    <span>
                      +{formatUsd(receipt.liveGrantedCents)} contingency
                    </span>
                  )}
                  {grantTransaction && (
                    <a
                      href={hashscanTransactionUrl(
                        grantTransaction.transactionId,
                      )}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Budget grant
                      <ExternalLink size={9} aria-hidden="true" />
                    </a>
                  )}
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
    </>
  );
}
