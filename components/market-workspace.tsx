"use client";

import { ArrowLeft, FlaskConical } from "lucide-react";
import Link from "next/link";

import { AgentSearchExperience } from "@/components/agent-search-experience";
import {
  MockExecutionDetails,
  ZeroGVerificationReceipt,
} from "@/components/execution-details";
import { usePurchaseSession } from "@/components/purchase-session";

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
      <div className={styles.boundary}>
        <span>
          <FlaskConical size={15} aria-hidden="true" />
        </span>
        <div>
          <strong>Trust boundary: local mock replay, then live proof</strong>
          <p>
            Sellers, rivals, auctions, and settlement are deterministic local
            simulation data. The verified 0G receipt follows the replay.
          </p>
        </div>
        <b>MOCK EXECUTION</b>
      </div>

      <AgentSearchExperience result={result} />
      <ZeroGVerificationReceipt result={result} />
      <MockExecutionDetails result={result} />
    </section>
  );
}
