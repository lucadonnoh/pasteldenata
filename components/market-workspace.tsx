"use client";

import { ArrowLeft, FlaskConical, Landmark } from "lucide-react";
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
      <div className={styles.boundary}>
        <span>
          <FlaskConical size={15} aria-hidden="true" />
        </span>
        <div>
          <strong>Trust boundary: private plan, mock market, live ledger</strong>
          <p>
            The prompt and 0G key stay in this tab. The derived plan drives
            mocked sellers and rivals; the active bids and payments are read
            from Hedera testnet when settlement is live.
          </p>
        </div>
        <b>{settlement === "idle" ? "MOCK EXECUTION" : "HEDERA TESTNET"}</b>
      </div>

      {settlement !== "idle" && (
        <div className={styles.verification} aria-live="polite">
          <span>
            <Landmark size={16} />
          </span>
          <div>
            <strong>
              {settlement === "pending" && "Hedera settlement in progress"}
              {settlement === "settled" && "Settled on Hedera testnet"}
              {settlement === "failed" && "Hedera settlement unavailable"}
            </strong>
            <p>
              {settlement === "pending" &&
                "Isolated agents are paying sellers with real atomic HTS transfers…"}
              {settlement === "settled" &&
                (result.hedera
                  ? `NATA ${result.hedera.paymentTokenId} · buyer wallet ${result.hedera.buyerAccountId} · receipts link to HashScan below`
                  : "Receipts link to HashScan below.")}
              {settlement === "failed" &&
                (settlementError || "Showing simulated receipts instead.")}
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
