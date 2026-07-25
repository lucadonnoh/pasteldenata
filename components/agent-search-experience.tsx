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
  Radio,
  ShieldCheck,
  Store,
  Trophy,
  UserCheck,
  Users,
  UtensilsCrossed,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type CSSProperties,
  useMemo,
  useState,
} from "react";

import type {
  Category,
  PlanAllocation,
  PurchaseSessionResult,
} from "@/src/domain";
import { formatUsd } from "@/src/money";
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

interface LiveAgentSearch {
  id: string;
  agentId: string;
  allocation: PlanAllocation;
}

interface MarketProgressCopy {
  stage: string;
  title: string;
  description: string;
  counter: string;
  percent: number;
}

function ratioPercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (completed / total) * 100));
}

function describeMarketProgress(
  live: LiveAuctionView,
  yourResolved: number,
  yourTotal: number,
): MarketProgressCopy {
  const progress = live.progress;
  const yourPurchases = live.settledCategories.length;
  const finalAuditStage =
    yourPurchases > 0
      ? "PURCHASES CONFIRMED · FINAL AUDIT"
      : "YOUR PLAN RESOLVED · FINAL AUDIT";
  const finalOutcomeCopy =
    yourPurchases > 0
      ? "Your confirmed swaps are final."
      : "Your agents have finished without overspending.";
  const rivalAgentTotal = Math.max(
    0,
    progress.totalAgents - yourTotal,
  );
  const rivalBuyerLabel = `${live.rivals.length} demo rival buyer${
    live.rivals.length === 1 ? "" : "s"
  }`;
  switch (progress.phase) {
    case "queued":
      return {
        stage: "SAFE EXECUTION QUEUE",
        title: "Your market run is reserved.",
        description:
          "Another Hedera run is finishing with the shared buyer wallets. Yours starts automatically as soon as those wallets are reconciled.",
        counter:
          live.queuePosition === 1
            ? "Next in queue"
            : `${live.queuePosition ?? "—"} runs ahead`,
        percent: 0,
      };
    case "preparing-market":
      return {
        stage: "OPENING AUTHENTICATED MARKET",
        title: "Creating HCS topics and funding scoped wallets.",
        description:
          "The coordinator is preparing the real Hedera market. No auction result is being simulated.",
        counter: `${live.listings.length}/${progress.totalTopics || "—"} topics`,
        percent: ratioPercent(live.listings.length, progress.totalTopics),
      };
    case "reconciling-wallets":
      return {
        stage: finalAuditStage,
        title: "Reconciling every buyer-agent wallet.",
        description: `${finalOutcomeCopy} The coordinator is now matching each wallet spend to its receipt and sweeping unused balances.`,
        counter: `${progress.reconciledWallets}/${progress.totalWallets} wallets`,
        percent: ratioPercent(
          progress.reconciledWallets,
          progress.totalWallets,
        ),
      };
    case "refunding-buyers":
      return {
        stage: finalAuditStage,
        title: "Returning every unused budget balance.",
        description:
          "Wallet reconciliation passed. Unspent mandate and contingency funds are being returned to the buyer wallets.",
        counter: `${progress.refundedBuyers}/${progress.totalBuyers} buyers`,
        percent: ratioPercent(
          progress.refundedBuyers,
          progress.totalBuyers,
        ),
      };
    case "verifying-hcs":
      return {
        stage: finalAuditStage,
        title: "Replaying the public HCS audit trail.",
        description:
          "The coordinator is independently reading every auction topic from Mirror Node before declaring the shared market complete.",
        counter: `${progress.verifiedTopics}/${progress.totalTopics} topics`,
        percent: ratioPercent(
          progress.verifiedTopics,
          progress.totalTopics,
        ),
      };
    case "complete":
      return {
        stage: "MARKET AUDIT COMPLETE",
        title: "Every wallet and HCS topic was reconciled.",
        description:
          "The shared market has closed and all confirmed receipts are ready.",
        counter: "Complete",
        percent: 100,
      };
    default: {
      const allYourAgentsResolved =
        yourTotal > 0 && yourResolved === yourTotal;
      const remainingAgents = Math.max(
        0,
        progress.totalAgents - progress.resolvedAgents,
      );
      if (allYourAgentsResolved) {
        return {
          stage: "YOUR PLAN RESOLVED · SHARED MARKET CLOSING",
          title:
            yourPurchases > 0
              ? `${yourPurchases} Hedera swap${yourPurchases === 1 ? "" : "s"} confirmed.`
              : "Your agents finished without overspending.",
          description:
            remainingAgents > 0
              ? `Your outcome is final. ${remainingAgents} of the ${rivalAgentTotal} agents representing the ${rivalBuyerLabel} are still bidding. Wallet reconciliation starts after they finish.`
              : "All scoped buyer agents have finished. Wallet reconciliation starts next.",
          counter: `${progress.resolvedAgents} of ${progress.totalAgents} finished`,
          percent: ratioPercent(
            progress.resolvedAgents,
            progress.totalAgents,
          ),
        };
      }
      return {
        stage: "ASCENDING AUCTIONS · ON-CHAIN",
        title: "Buyer agents are competing for scarce items.",
        description: `This run has ${progress.totalAgents} scoped buyer agents: ${yourTotal} for your plan and ${rivalAgentTotal} for the ${rivalBuyerLabel}. ${progress.resolvedAgents} have either settled or stopped bidding.`,
        counter: `${progress.resolvedAgents} of ${progress.totalAgents || "—"} finished`,
        percent: ratioPercent(
          progress.resolvedAgents,
          progress.totalAgents,
        ),
      };
    }
  }
}

export function AgentSearchExperience({
  result,
  live,
}: {
  result: PurchaseSessionResult;
  live?: LiveAuctionView;
}) {
  const searches = useMemo(
    () =>
      result.plan.allocations.map((allocation, index) => ({
        id: `agent_${allocation.category}_${index + 1}`,
        agentId: `hedera_wallet_pending_${allocation.category}`,
        allocation,
      })),
    [result.plan.allocations],
  );

  if (!live) {
    return (
      <section className={styles.experience} aria-live="polite">
        <header className={styles.heading}>
          <div>
            <span>HEDERA TESTNET · STARTING</span>
            <h2>Waiting for the live market job.</h2>
            <p>No local auction or simulated receipt will be substituted.</p>
          </div>
        </header>
      </section>
    );
  }

  return (
    <LiveAgentSearchRun
      result={result}
      searches={searches}
      live={live}
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
  result: PurchaseSessionResult;
  searches: LiveAgentSearch[];
  live: LiveAuctionView;
}) {
  const yourAgents = live.agents.filter(
    (agent) => agent.buyerName === "You",
  );
  const opened = live.listings.length > 0;
  const phase: "queued" | "searching" | "bidding" | "complete" | "failed" =
    live.queued
      ? "queued"
      : live.failed
      ? "failed"
      : live.done
        ? "complete"
        : opened
          ? "bidding"
          : "searching";
  const wonCount = result.receipts.filter(
    (receipt) => receipt.status === "hedera-settled",
  ).length;
  const yourResolved = new Set([
    ...live.settledCategories,
    ...live.lostCategories,
  ]).size;
  const marketProgress = describeMarketProgress(
    live,
    yourResolved,
    searches.length,
  );

  const phaseCopy = {
    queued: {
      eyebrow: "SAFE EXECUTION QUEUE · RESERVED",
      title: "Your private plan has a safe place in line.",
      description:
        "A previous market is finishing wallet reconciliation. Your run has its own job ID and starts automatically without sharing live wallet state.",
      status:
        live.queuePosition === 1
          ? "Next"
          : `Queue ${live.queuePosition ?? "—"}`,
    },
    searching: {
      eyebrow: `OPEN MARKET · ${live.rivals.length} RIVAL BUYERS ACTIVE`,
      title: "Agents are entering the market.",
      description:
        "Sellers list scarce items at a floor price. Your scoped agents compete against demo rival buyers using ledger-capped wallets.",
      status: `${yourAgents.length}/${searches.length} wallets live`,
    },
    bidding: {
      eyebrow: marketProgress.stage,
      title: marketProgress.title,
      description: marketProgress.description,
      status: marketProgress.counter,
    },
    complete: {
      eyebrow: `MARKET CLOSED · WON ${wonCount}/${searches.length} ON HEDERA`,
      title: result.plan.occasionTitle,
      description: `${result.plan.location} · ${result.plan.scheduledFor}`,
      status: "On-chain",
    },
    failed: {
      eyebrow: "HEDERA MARKET · FAILED CLOSED",
      title:
        wonCount > 0
          ? `${wonCount} purchase${wonCount === 1 ? "" : "s"} settled before failure.`
          : "No purchase was completed.",
      description:
        live.failure ??
        "The market stopped without substituting a simulated result.",
      status: wonCount > 0 ? "Partial" : "Failed",
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

      {phase === "queued" ? (
        <div className={styles.marketWaiting}>
          <Clock3 size={20} aria-hidden="true" />
          <strong>Your run is safely queued.</strong>
          <span>
            Keep this page open — the authenticated Hedera market will appear
            automatically.
          </span>
        </div>
      ) : phase === "searching" ? (
        <ActivityDiscovery
          searches={searches}
          agents={yourAgents}
        />
      ) : phase === "bidding" ? (
        <MarketBidStage searches={searches} live={live} />
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
  agents,
}: {
  searches: LiveAgentSearch[];
  agents: LiveAuctionView["agents"];
}) {
  const resolvedCategories = new Set(
    agents
      .filter((agent) => agent.buyerName === "You")
      .map((agent) => agent.category),
  );
  return (
    <>
      <div className={styles.orbitScene}>
        <div className={styles.dreamWash} />
        <div className={styles.orbitLine} />
        <div className={styles.core}>
          <Users size={18} aria-hidden="true" />
          <strong>{resolvedCategories.size}</strong>
          <span>WALLETS LIVE</span>
        </div>
        {searches.map((search, index) => {
          const CategoryIcon = categoryIcons[search.allocation.category];
          const agent = agents.find(
            (candidate) =>
              candidate.buyerName === "You" &&
              candidate.category === search.allocation.category,
          );
          const found = Boolean(agent);
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
                  <code>{agent?.accountId ?? "wallet pending…"}</code>
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
              className={
                resolvedCategories.has(search.allocation.category)
                  ? styles.ledgerFound
                  : ""
              }
            >
              {resolvedCategories.has(search.allocation.category)
                ? <Check size={10} />
                : index + 1}
            </span>
            <div>
              <strong>{search.allocation.category}</strong>
              <code>
                {agents.find(
                  (candidate) =>
                    candidate.buyerName === "You" &&
                    candidate.category === search.allocation.category,
                )?.accountId ?? "wallet pending…"}
              </code>
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
  searches: LiveAgentSearch[];
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
  const progressCopy = describeMarketProgress(
    live,
    settledCount,
    searches.length,
  );
  const otherListings = activeListings.filter(
    (listing) => listing.itemId !== focus?.itemId,
  );
  const userWorldBlocks =
    live.world?.blocked.filter((entry) => entry.buyerName === "You") ?? [];

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
            <small>HEDERA TESTNET · {progressCopy.stage}</small>
            <strong>{progressCopy.title}</strong>
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
            <dt>Wallets funded</dt>
            <dd>{live.agents.length}</dd>
          </div>
          <div>
            <dt>Buyer agents finished</dt>
            <dd>
              {live.progress.resolvedAgents}/
              {live.progress.totalAgents || "—"}
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
          const categorySettlement = visible
            .filter((listing) => listing.category === category)
            .map((listing) =>
              marketSettlementFromEvents(
                live.ledgerEventsByItem[listing.itemId] ?? [],
              ),
            )
            .find((settlement) => settlement?.yours);
          const displayedAmount =
            categorySettlement?.amountCents ?? effectiveCap;

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
                  categorySettlement
                    ? `${formatUsd(categorySettlement.amountCents)} final clearing price; ${formatUsd(effectiveCap)} mandate cap`
                    : granted > 0
                    ? `${formatUsd(initialCap)} initial mandate plus ${formatUsd(granted)} on-chain contingency`
                    : `${formatUsd(initialCap)} funded mandate`
                }
              >
                <b>{formatUsd(displayedAmount)}</b>
                {categorySettlement ? (
                  <small>clearing price</small>
                ) : granted > 0 ? (
                  <small>+{formatUsd(granted)} grant</small>
                ) : (
                  <small>mandate cap</small>
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

      <div
        className={styles.marketRunProgress}
        data-phase={live.progress.phase}
        aria-live="polite"
      >
        <span className={styles.marketRunProgressIcon}>
          {live.progress.phase === "running-auctions" ? (
            <Activity size={16} aria-hidden="true" />
          ) : (
            <ShieldCheck size={16} aria-hidden="true" />
          )}
        </span>
        <div className={styles.marketRunProgressCopy}>
          <small>{progressCopy.stage}</small>
          <strong>{progressCopy.title}</strong>
          <p>{progressCopy.description}</p>
        </div>
        <div className={styles.marketRunProgressMeter}>
          <code>{progressCopy.counter}</code>
          <span>
            <i style={{ width: `${progressCopy.percent}%` }} />
          </span>
        </div>
      </div>

      {live.world && (
        <div
          className={styles.worldGateStatus}
          data-status={live.world.userHumanStatus}
          aria-live="polite"
        >
          <span>
            {live.world.userHumanStatus === "verified" ? (
              <UserCheck size={15} aria-hidden="true" />
            ) : live.world.userHumanStatus === "unverified" ? (
              <X size={15} aria-hidden="true" />
            ) : (
              <Clock3 size={15} aria-hidden="true" />
            )}
          </span>
          <div>
            <small>WORLD AGENTBOOK · SELLER-SIDE ACCESS CONTROL</small>
            <strong>
              {live.world.userHumanStatus === "verified"
                ? `Verified human — ${live.world.userPassesIssued} protected-auction pass${live.world.userPassesIssued === 1 ? "" : "es"} issued to your agents.`
                : live.world.userHumanStatus === "unverified"
                  ? "Unverified visitor — protected sellers refuse your agents."
                  : "Checking the selected identity in the canonical AgentBook…"}
            </strong>
            <p>
              {live.world.userHumanStatus === "verified"
                ? "Each pass is bound to one auction and one leaf wallet; the raw World human identifier is not published."
                : live.world.userHumanStatus === "unverified"
                  ? userWorldBlocks.length > 0
                    ? `${userWorldBlocks.length} protected purchase attempt${userWorldBlocks.length === 1 ? " was" : "s were"} blocked. Open listings remain available.`
                    : "The market still runs normally. The rejection becomes visible when a protected listing checks the buyer credential."
                  : "The server has proved control of the address. Human-backing is a separate on-chain lookup."}
            </p>
          </div>
        </div>
      )}

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
                  <small>
                    {focus.sellerName}
                    {focus.humanPolicy === "one-per-human" && (
                      <i
                        className={styles.humanGate}
                        title="This seller admits only agents backed by a verified human (World ID) — one allocation per human, pinned in the on-chain listing"
                      >
                        verified humans only
                      </i>
                    )}
                  </small>
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
                      : event.type === "AUTHORIZED"
                        ? yours
                          ? "Your World credential was accepted"
                          : `Bidder ${shortAccount(event.bidder)} is human-backed`
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
                      : event.type === "AUTHORIZED"
                        ? `nullifier ${event.nullifier}`
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
                        ) : event.type === "AUTHORIZED" ? (
                          <ShieldCheck size={11} aria-hidden="true" />
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

function BundleGrid({
  searches,
  result,
  lostCategories = [],
  agentAccounts = [],
}: {
  searches: LiveAgentSearch[];
  result: PurchaseSessionResult;
  lostCategories?: string[];
  agentAccounts?: LiveAuctionView["agents"];
}) {
  const isLost = (search: LiveAgentSearch) =>
    !result.receipts.some(
      (receipt) =>
        receipt.category === search.allocation.category &&
        receipt.status === "hedera-settled",
    ) && lostCategories.includes(search.allocation.category);
  const securedCount = result.receipts.filter(
    (receipt) => receipt.status === "hedera-settled",
  ).length;
  const totalSettledCents = result.receipts.reduce(
    (total, receipt) => total + receipt.amountCents,
    0,
  );

  return (
    <>
      <div className={styles.bundleSummary}>
        <span>
          <Check size={18} strokeWidth={2.7} aria-hidden="true" />
        </span>
        <div>
          <small>
            HEDERA MARKET RESULT
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
        const visibleTags = search.allocation.requirements.slice(0, 3);

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
                {lost
                  ? "No purchase"
                  : receipt?.sellerName ?? "Settlement incomplete"}
              </h3>
              <p>
                {lost
                  ? "Rivals pushed every listing beyond this mandate. The agent walked away instead of overspending."
                  : receipt?.offering ??
                    "The Hedera market did not produce a confirmed atomic swap for this mandate."}
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
                    lost ? 0 : (receipt?.amountCents ?? 0),
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
