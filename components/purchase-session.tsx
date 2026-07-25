"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

import type { PurchaseSessionResult } from "@/src/domain";

export type HederaSettlementStatus = "idle" | "pending" | "settled" | "failed";

interface PurchaseSessionValue {
  result: PurchaseSessionResult | null;
  setResult: (result: PurchaseSessionResult | null) => void;
  settlement: HederaSettlementStatus;
  setSettlement: (status: HederaSettlementStatus) => void;
  settlementError: string;
  setSettlementError: (message: string) => void;
  jobId: string | null;
  setJobId: (jobId: string | null) => void;
}

const PurchaseSessionContext =
  createContext<PurchaseSessionValue | null>(null);

export function PurchaseSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [result, setResult] = useState<PurchaseSessionResult | null>(null);
  const [settlement, setSettlement] =
    useState<HederaSettlementStatus>("idle");
  const [settlementError, setSettlementError] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const value = useMemo(
    () => ({
      result,
      setResult,
      settlement,
      setSettlement,
      settlementError,
      setSettlementError,
      jobId,
      setJobId,
    }),
    [result, settlement, settlementError, jobId],
  );

  return (
    <PurchaseSessionContext.Provider value={value}>
      {children}
    </PurchaseSessionContext.Provider>
  );
}

export function usePurchaseSession(): PurchaseSessionValue {
  const value = useContext(PurchaseSessionContext);

  if (!value) {
    throw new Error(
      "usePurchaseSession must be used inside PurchaseSessionProvider.",
    );
  }

  return value;
}
