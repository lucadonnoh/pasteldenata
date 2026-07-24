"use client";

import { ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { AgentSearchExperience } from "@/components/agent-search-experience";
import { ExecutionDetails } from "@/components/execution-details";
import { usePurchaseSession } from "@/components/purchase-session";
import { formatUsd } from "@/src/money";

import styles from "@/app/market/market.module.css";

export function MarketWorkspace() {
  const { result } = usePurchaseSession();

  if (!result) {
    return (
      <section className={styles.emptyState}>
        <span>PRIVATE SESSION ENDED</span>
        <h1>No active market search.</h1>
        <p>
          Results live only in this browser tab and disappear after a reload.
        </p>
        <Link href="/">
          <ArrowLeft size={14} />
          Start a new intent
        </Link>
      </section>
    );
  }

  return (
    <section className={styles.marketWorkspace}>
      <div className={styles.verification}>
        <span>
          <ShieldCheck size={16} />
        </span>
        <div>
          <strong>Private plan verified</strong>
          <p>
            {result.plan.allocations.length} scoped mandates ·{" "}
            {formatUsd(result.plan.totalBudgetCents)} hard cap
          </p>
        </div>
        <b>TEE VERIFIED</b>
      </div>

      <AgentSearchExperience result={result} />
      <ExecutionDetails result={result} />
    </section>
  );
}
