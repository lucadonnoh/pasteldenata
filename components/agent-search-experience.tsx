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
  useEffect,
  useMemo,
  useState,
} from "react";

import type {
  Category,
  PlanAllocation,
  PurchaseSessionResult,
} from "@/src/domain";
import {
  expectedMarketCloseAtMs,
  MARKET_HARD_CLOSE_MS,
  MARKET_MIN_AUCTION_MS,
  MARKET_QUIET_CLOSE_MS,
} from "@/src/hedera/marketTiming";
import { latestBidActivity } from "@/src/hedera/marketFocus";
import { wasPreventedFromBidding } from "@/src/hedera/marketOutcome";
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
          listings={live.listings}
          bidsByItem={live.bidsByItem}
          worldBlocks={live.world?.blocked ?? []}
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

function marketEventTitle(event: MarketEvent): string {
  const yours = "yours" in event && event.yours;
  if (event.type === "LISTED") return "Clearing opened the listing";
  if (event.type === "AUTHORIZED") {
    return yours
      ? "Your World credential was accepted"
      : `Bidder ${shortAccount(event.bidder)} is human-backed`;
  }
  if (event.type === "CLOSED") return "Clearing closed bidding";
  if (event.type === "FORFEITED") {
    return yours
      ? "Your claim window expired"
      : `Bidder ${shortAccount(event.bidder)} forfeited`;
  }
  if (event.type === "SETTLED") {
    return yours
      ? "Your atomic swap settled"
      : `Bidder ${shortAccount(event.bidder)} settled`;
  }
  return yours
    ? "Your agent placed a bid"
    : `Rival ${shortAccount(event.bidder)} raised`;
}

function marketEventDetail(event: MarketEvent): string {
  if (event.type === "SETTLED") return event.transactionId;
  if (event.type === "AUTHORIZED") return `nullifier ${event.nullifier}`;
  if ("bidder" in event) return event.bidder;
  return event.payerAccountId;
}

function MarketEventIcon({ event }: { event: MarketEvent }) {
  const yours = "yours" in event && event.yours;
  if (event.type === "SETTLED") {
    return <CheckCircle2 size={11} aria-hidden="true" />;
  }
  if (event.type === "AUTHORIZED") {
    return <ShieldCheck size={11} aria-hidden="true" />;
  }
  if (event.type === "FORFEITED") {
    return <X size={11} aria-hidden="true" />;
  }
  if (event.type === "CLOSED") {
    return <Gavel size={11} aria-hidden="true" />;
  }
  if (event.type === "LISTED") {
    return <Radio size={11} aria-hidden="true" />;
  }
  return yours ? (
    <Check size={11} aria-hidden="true" />
  ) : (
    <Store size={11} aria-hidden="true" />
  );
}

function consensusTimeMs(timestamp?: string): number | undefined {
  if (!timestamp) return undefined;
  const [seconds, nanos = "0"] = timestamp.split(".");
  const secondsNumber = Number(seconds);
  const nanosNumber = Number(nanos.padEnd(9, "0").slice(0, 9));
  if (!Number.isFinite(secondsNumber) || !Number.isFinite(nanosNumber)) {
    return undefined;
  }
  return secondsNumber * 1000 + nanosNumber / 1_000_000;
}

function latestConsensusEventMs(events: MarketEvent[]): number {
  return events.reduce((latest, event) => {
    const timestamp = consensusTimeMs(event.consensusTimestamp);
    return timestamp === undefined ? latest : Math.max(latest, timestamp);
  }, 0);
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const latestLiveBid = useMemo(
    () => latestBidActivity(live.activity, categorySet),
    [categorySet, live.activity],
  );
  const followedCategory = useMemo(
    () => {
      if (latestLiveBid) return latestLiveBid.category as Category;
      return [...categories].sort((left, right) => {
        const activity = (category: Category) => {
          const listings = visible.filter(
            (listing) => listing.category === category,
          );
          const bids = visible
            .filter((listing) => listing.category === category)
            .flatMap(
              (listing) => live.bidsByItem[listing.itemId] ?? [],
            );
          const leading = listings.some(
            (listing) =>
              listingVisualState(
                listing,
                live.bidsByItem[listing.itemId] ?? [],
                live.ledgerEventsByItem[listing.itemId] ?? [],
              ) === "leading",
          );
          const latestEventMs = listings.reduce(
            (latest, listing) =>
              Math.max(
                latest,
                latestConsensusEventMs(
                  live.ledgerEventsByItem[listing.itemId] ?? [],
                ),
              ),
            0,
          );
          return { latestEventMs, bids: bids.length, leading };
        };
        const rightActivity = activity(right);
        const leftActivity = activity(left);
        return (
          rightActivity.bids - leftActivity.bids ||
          rightActivity.latestEventMs - leftActivity.latestEventMs ||
          Number(rightActivity.leading) - Number(leftActivity.leading)
        );
      })[0];
    },
    [
      categories,
      latestLiveBid,
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
    const activity = (listing: MarketListing) => {
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
      return {
        latestEventMs: latestConsensusEventMs(events),
        stateWeight: stateWeight[state],
        sequence: latestMarketSequence(events),
      };
    };
    const rightActivity = activity(right);
    const leftActivity = activity(left);
    return (
      rightActivity.latestEventMs - leftActivity.latestEventMs ||
      rightActivity.stateWeight - leftActivity.stateWeight ||
      rightActivity.sequence - leftActivity.sequence
    );
  })[0];
  const selectedFocus = activeListings.find(
    (listing) => listing.itemId === selectedItemId,
  );
  const focus = selectedFocus ?? automaticFocus;
  const manualFocus =
    pinnedCategory !== null || selectedItemId !== null;

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
  const latestLiveBidAmount =
    latestLiveBid?.event.type === "BID" &&
    "amountCents" in latestLiveBid.event
      ? latestLiveBid.event.amountCents
      : undefined;
  const focusHasLatestBid =
    focus?.itemId === latestLiveBid?.itemId;
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
  const focusOpeningMs = consensusTimeMs(
    focusEvents.find((event) => event.type === "LISTED")
      ?.consensusTimestamp,
  );
  const focusLatestBidMs = [...focusEvents]
    .reverse()
    .find((event) => event.type === "BID");
  const focusExpectedCloseAt =
    focusOpeningMs === undefined
      ? undefined
      : expectedMarketCloseAtMs(
          focusOpeningMs,
          consensusTimeMs(focusLatestBidMs?.consensusTimestamp) ??
            focusOpeningMs,
        );
  const focusCloseSeconds =
    focusExpectedCloseAt === undefined
      ? undefined
      : Math.max(0, Math.ceil((focusExpectedCloseAt - now) / 1000));
  const otherCategoryBids = activeListings
    .filter((listing) => listing.itemId !== focus?.itemId)
    .reduce(
      (sum, listing) =>
        sum + (live.bidsByItem[listing.itemId]?.length ?? 0),
      0,
    );
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
  const userWorldBlocks =
    live.world?.blocked.filter((entry) => entry.buyerName === "You") ?? [];
  const recentMarketActivity = live.activity
    .filter((entry) => categorySet.has(entry.category as Category))
    .slice(0, 8);
  const latestConsensusMs = consensusTimeMs(
    recentMarketActivity[0]?.event.consensusTimestamp,
  );
  const secondsSinceActivity =
    latestConsensusMs === undefined
      ? undefined
      : Math.max(0, Math.floor((now - latestConsensusMs) / 1000));

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
      <div className={styles.marketCommandBar}>
        <div className={styles.marketCommandStatus}>
          <span>
            <Radio size={14} aria-hidden="true" />
          </span>
          <div>
            <small>HEDERA TESTNET · {progressCopy.stage}</small>
            <strong>{progressCopy.title}</strong>
            <em>
              {secondsSinceActivity === undefined
                ? "Syncing authenticated events"
                : `Consensus pulse ${secondsSinceActivity}s ago`}
            </em>
          </div>
        </div>
        <nav
          className={styles.marketCategoryTabs}
          aria-label="Choose an allocation buyer agent"
        >
          {categories.map((category) => {
            const state = categoryState(category);
            const CategoryIcon = categoryIcons[category];
            const active = category === activeCategory;
            return (
              <button
                type="button"
                key={category}
                data-state={state}
                data-active={active || undefined}
                aria-pressed={active}
                onClick={() => {
                  setPinnedCategory(category);
                  setSelectedItemId(null);
                }}
              >
                {state === "won" ? (
                  <Trophy size={12} aria-hidden="true" />
                ) : (
                  <CategoryIcon size={12} aria-hidden="true" />
                )}
                <span>
                  <strong>{category}</strong>
                  <small>{marketStateLabel(state)}</small>
                </span>
              </button>
            );
          })}
        </nav>
        <div className={styles.marketCommandMeta}>
          <span><b>{totalBids}</b> bids</span>
          <span><b>{live.agents.length}</b> agents</span>
          <span><b>{visible.length}</b> topics</span>
          {live.world && (
            <details
              className={styles.worldCompact}
              data-status={live.world.userHumanStatus}
            >
              <summary>
                {live.world.userHumanStatus === "verified" ? (
                  <UserCheck size={12} aria-hidden="true" />
                ) : live.world.userHumanStatus === "unverified" ? (
                  <X size={12} aria-hidden="true" />
                ) : (
                  <Clock3 size={12} aria-hidden="true" />
                )}
                World
              </summary>
              <div>
                <strong>
                  {live.world.userHumanStatus === "verified"
                    ? `${live.world.userPassesIssued} auction pass${live.world.userPassesIssued === 1 ? "" : "es"} issued`
                    : live.world.userHumanStatus === "unverified"
                      ? "Protected sellers refuse this identity"
                      : "Checking AgentBook identity"}
                </strong>
                <p>
                  {live.world.userHumanStatus === "verified"
                    ? "Each credential is bound to one listing and one leaf wallet."
                    : userWorldBlocks.length > 0
                      ? `${userWorldBlocks.length} protected attempt${userWorldBlocks.length === 1 ? "" : "s"} blocked; open listings remain available.`
                      : "The market remains live while the seller-side policy resolves."}
                </p>
              </div>
            </details>
          )}
          <button
            type="button"
            className={styles.compactFollowButton}
            data-following={!manualFocus || undefined}
            onClick={() => {
              setPinnedCategory(null);
              setSelectedItemId(null);
            }}
            aria-label={
              manualFocus
                ? "Resume following the newest authenticated HCS bid"
                : "Following the newest authenticated HCS bid"
            }
          >
            <Activity size={12} aria-hidden="true" />
            {manualFocus ? "Resume live" : "Following live bids"}
          </button>
        </div>
        {live.progress.phase !== "running-auctions" && (
          <div className={styles.marketAuditStrip}>
            <ShieldCheck size={13} aria-hidden="true" />
            <span>{progressCopy.description}</span>
            <b>{progressCopy.counter}</b>
            <i>
              <em style={{ width: `${progressCopy.percent}%` }} />
            </i>
          </div>
        )}
      </div>

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

              {activeListings.length > 1 && (
                <nav
                  className={styles.listingSwitcher}
                  aria-label={`Choose a ${activeCategory} listing`}
                >
                  <span>{manualFocus ? "Inspecting" : "Live focus"}</span>
                  {activeListings.map((listing) => {
                    const bids = live.bidsByItem[listing.itemId] ?? [];
                    const events =
                      live.ledgerEventsByItem[listing.itemId] ?? [];
                    const high = highestMarketBid(bids);
                    const settlement = marketSettlementFromEvents(events);
                    const active = listing.itemId === focus.itemId;
                    return (
                      <button
                        type="button"
                        key={listing.itemId}
                        data-active={active || undefined}
                        onClick={() => {
                          setPinnedCategory(activeCategory ?? null);
                          setSelectedItemId(listing.itemId);
                        }}
                      >
                        {listing.sellerName}
                        <b>
                          {formatUsd(
                            settlement?.amountCents ??
                              high?.amountCents ??
                              listing.floorCents,
                          )}
                        </b>
                        <small>{bids.length} bids</small>
                      </button>
                    );
                  })}
                  {manualFocus && (
                    <button
                      type="button"
                      className={styles.resumeFocus}
                      onClick={() => {
                        setPinnedCategory(null);
                        setSelectedItemId(null);
                      }}
                    >
                      <Activity size={11} aria-hidden="true" />
                      Resume live
                    </button>
                  )}
                </nav>
              )}

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
                      : `Highest bid on ${focus.sellerName}'s HCS topic`}
                </span>
                <strong
                  key={`${focus.itemId}:${currentPrice}`}
                  className={styles.livePrice}
                >
                  {formatUsd(currentPrice)}
                </strong>
                <small>
                  {focusBids.length} authenticated HCS bid
                  {focusBids.length === 1 ? "" : "s"}
                  {!manualFocus && !focusSettlement
                    ? " · following the newest live bid"
                    : ""}
                </small>
              </div>

              {manualFocus &&
                latestLiveBid &&
                !focusHasLatestBid &&
                latestLiveBidAmount !== undefined && (
                  <button
                    type="button"
                    className={styles.liveBidNudge}
                    onClick={() => {
                      setPinnedCategory(null);
                      setSelectedItemId(null);
                    }}
                  >
                    <Activity size={13} aria-hidden="true" />
                    <span>
                      Live market moved
                      <strong>
                        {latestLiveBid.sellerName} ·{" "}
                        {formatUsd(latestLiveBidAmount)}
                      </strong>
                    </span>
                    <b>Follow</b>
                  </button>
                )}

              {!focusSettlement && !focus.sold && (
                <div
                  className={styles.auctionCloseStatus}
                  data-ready={focusCloseSeconds === 0 || undefined}
                >
                  <span>
                    <Clock3 size={15} aria-hidden="true" />
                  </span>
                  <div>
                    <small>REAL AUCTION CLOSE POLICY</small>
                    <strong>
                      {focusCloseSeconds === undefined
                        ? "Reading the opening consensus timestamp…"
                        : focusCloseSeconds > 0
                          ? `Counter-bid window open for about ${focusCloseSeconds}s`
                          : focusState === "leading"
                            ? "Your lead is being verified before settlement"
                            : "Clearing is deriving the final HCS ranking"}
                    </strong>
                    <p>
                      Listings stay open at least{" "}
                      {MARKET_MIN_AUCTION_MS / 1_000}s, close after{" "}
                      {MARKET_QUIET_CLOSE_MS / 1_000}s without a bid, and
                      hard-close by {MARKET_HARD_CLOSE_MS / 1_000}s.
                      {otherCategoryBids > 0
                        ? ` ${otherCategoryBids} authenticated bid${otherCategoryBids === 1 ? " is" : "s are"} active on the other ${activeCategory} topic${activeListings.length > 2 ? "s" : ""}.`
                        : " Your agent is holding its funded lead while rivals can respond."}
                    </p>
                  </div>
                  <b>
                    {focusCloseSeconds === undefined
                      ? "SYNC"
                      : focusCloseSeconds > 0
                        ? `${focusCloseSeconds}s`
                        : "VERIFY"}
                  </b>
                </div>
              )}

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

              <details className={styles.focusProof}>
                <summary>
                  <ShieldCheck size={13} aria-hidden="true" />
                  On-chain proof and explorer links
                  <code>{focus.topicId}</code>
                </summary>
                <div className={styles.focusChainLinks}>
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
                    HCS topic
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
                  <p>
                    Bids match their payer; listing lifecycle events match
                    clearing; settlement is one atomic NATA-for-claim swap.
                  </p>
                </div>
              </details>
            </article>

            <aside className={styles.marketActivity}>
              <header>
                <div>
                  <Activity size={13} aria-hidden="true" />
                  <span>MARKET PULSE · ALL TOPICS</span>
                </div>
                <b>
                  <i />
                  LIVE
                </b>
              </header>
              <ol>
                {recentMarketActivity.slice(0, 5).map((entry, index) => {
                  const { event } = entry;
                  const yours =
                    "yours" in event && event.yours;
                  const amount =
                    "amountCents" in event
                      ? event.amountCents
                      : undefined;

                  return (
                    <li
                      key={`${entry.itemId}:${event.type}:${event.sequenceNumber}`}
                      className={
                        yours ? styles.yourMarketEvent : ""
                      }
                      data-kind={event.type.toLowerCase()}
                      data-newest={index === 0 || undefined}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setPinnedCategory(entry.category as Category);
                          setSelectedItemId(entry.itemId);
                        }}
                        title={`${marketEventDetail(event)} · focus ${entry.offering}`}
                      >
                        <span>
                          <MarketEventIcon event={event} />
                        </span>
                        <div>
                          <small>
                            {entry.category} · HCS #{event.sequenceNumber}
                          </small>
                          <strong>{marketEventTitle(event)}</strong>
                          <code>{entry.sellerName}</code>
                        </div>
                        {amount !== undefined && (
                          <b>{formatUsd(amount)}</b>
                        )}
                      </button>
                    </li>
                  );
                })}
                {recentMarketActivity.length === 0 && (
                  <li className={styles.awaitingBid}>
                    <button type="button">
                      <span>
                        <Clock3 size={12} aria-hidden="true" />
                      </span>
                      <div>
                        <small>TOPICS OPEN</small>
                        <strong>Reading authenticated HCS evidence</strong>
                        <code>Mirror Node refreshes every 1.5s</code>
                      </div>
                    </button>
                  </li>
                )}
              </ol>
              <footer>
                <span>
                  Latest {Math.min(5, recentMarketActivity.length)} of{" "}
                  {live.activity.length} authenticated events
                </span>
                <b>{totalBids} bids across {visible.length} topics</b>
              </footer>
            </aside>
          </div>
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
  listings = [],
  bidsByItem = {},
  worldBlocks = [],
}: {
  searches: LiveAgentSearch[];
  result: PurchaseSessionResult;
  lostCategories?: string[];
  agentAccounts?: LiveAuctionView["agents"];
  listings?: LiveAuctionView["listings"];
  bidsByItem?: LiveAuctionView["bidsByItem"];
  worldBlocks?: NonNullable<LiveAuctionView["world"]>["blocked"];
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
        const accessBlocked =
          lost &&
          wasPreventedFromBidding({
            buyerName: "You",
            category: search.allocation.category,
            listings,
            bidsByItem,
            blocks: worldBlocks,
          });
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
                {accessBlocked
                  ? "Couldn’t enter"
                  : lost
                    ? "Outbid"
                    : onChain
                      ? "On-chain"
                      : "Secured"}
              </span>
            </div>
            <div className={styles.resultBody}>
              <h3>
                {lost
                  ? accessBlocked
                    ? "Could not participate"
                    : "No purchase"
                  : receipt?.sellerName ?? "Settlement incomplete"}
              </h3>
              <p>
                {lost
                  ? accessBlocked
                    ? `Every ${search.allocation.category} listing required a verified World ID. Seller-side authorization rejected this agent before it could place a bid.`
                    : "Rivals pushed every listing beyond this mandate. The agent walked away instead of overspending."
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
