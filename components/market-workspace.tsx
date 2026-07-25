"use client";

import { ArrowLeft, Landmark } from "lucide-react";
import Link from "next/link";

import { AgentSearchExperience } from "@/components/agent-search-experience";
import {
  MockExecutionDetails,
  ZeroGVerificationReceipt,
} from "@/components/execution-details";
import { usePurchaseSession } from "@/components/purchase-session";
import { useSettlementJob } from "@/components/use-settlement-job";

import styles from "@/app/market/market.module.css";

export function MarketWorkspace() {
  const { result, settlement, settlementError } = usePurchaseSession();
  const live = useSettlementJob();

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
      {settlement !== "idle" && (
        <div
          className={`${styles.settlementStrip} ${
            settlement === "settled"
              ? styles.settlementOk
              : settlement === "failed"
                ? styles.settlementFailed
                : ""
          }`}
          aria-live="polite"
        >
          <span>
            <Landmark size={16} />
          </span>
          <div>
            <strong>
              {settlement === "pending" && "Hedera settlement in progress"}
              {settlement === "settled" && "Settled on Hedera testnet"}
              {settlement === "failed" && "Hedera settlement unavailable — showing the simulation"}
            </strong>
            <p>
              {settlement === "pending" &&
                "Isolated agents are paying sellers with real atomic HTS transfers…"}
              {settlement === "settled" &&
                (result.hedera
                  ? `NATA ${result.hedera.paymentTokenId} · buyer wallet ${result.hedera.buyerAccountId} · receipts link to HashScan below`
                  : "Receipts link to HashScan below.")}
              {settlement === "failed" &&
                (settlementError ||
                  "The local coordinator could not settle on testnet; the mock trace below is unaffected.")}
            </p>
          </div>
          <b>
            {settlement === "pending"
              ? "LIVE"
              : settlement === "settled"
                ? "ON-CHAIN"
                : "SIMULATED"}
          </b>
        </div>
      )}

      <AgentSearchExperience result={result} {...(live ? { live } : {})} />
      <ZeroGVerificationReceipt result={result} />
      <MockExecutionDetails result={result} />
    </section>
  );
}
