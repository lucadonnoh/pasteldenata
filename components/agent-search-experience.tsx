"use client";

import {
  CarFront,
  Check,
  Clapperboard,
  Flower2,
  Palette,
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

const SEARCH_DURATION_MS = 3600;

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
  const [phase, setPhase] = useState<"searching" | "complete">("searching");
  const [resolvedCount, setResolvedCount] = useState(0);

  useEffect(() => {
    const resolutionTimers = searches.map((_, index) =>
      window.setTimeout(
        () => setResolvedCount(index + 1),
        950 + index * 650,
      ),
    );
    const completionTimer = window.setTimeout(
      () => setPhase("complete"),
      SEARCH_DURATION_MS,
    );

    return () => {
      resolutionTimers.forEach(window.clearTimeout);
      window.clearTimeout(completionTimer);
    };
  }, [searches]);

  return (
    <section className={styles.experience} aria-live="polite">
      <header className={styles.heading}>
        <div>
          <span>
            {phase === "searching"
              ? `${searches.length} AGENT WALLETS ACTIVE`
              : "BUNDLE ASSEMBLED"}
          </span>
          <h2>
            {phase === "searching"
              ? "Searching the market in parallel."
              : result.plan.occasionTitle}
          </h2>
          <p>
            {phase === "searching"
              ? "Each agent sees one activity, one budget and nothing else."
              : `${result.plan.location} · ${result.plan.scheduledFor}`}
          </p>
        </div>
        <div className={styles.phasePill}>
          <i className={phase === "complete" ? styles.completeDot : ""} />
          {phase === "searching" ? "Dreaming" : "Ready"}
        </div>
      </header>

      {phase === "searching" ? (
        <DreamOrbit searches={searches} resolvedCount={resolvedCount} />
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
                    index < resolvedCount ? styles.found : ""
                  }`}
                >
                  <header>
                    <span>
                      <CategoryIcon size={14} />
                    </span>
                    <b>
                      {index < resolvedCount ? (
                        <>
                          <Check size={10} />
                          Match
                        </>
                      ) : (
                        "Searching"
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
                ? `${search.auction.winner.sellerName} found`
                : "scanning"}
            </b>
          </div>
        ))}
      </div>
    </>
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
