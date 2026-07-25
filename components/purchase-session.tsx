"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

import type { DemoResult } from "@/src/domain";

export type HederaSettlementStatus = "idle" | "pending" | "settled" | "failed";

interface PurchaseSessionValue {
  result: DemoResult | null;
  setResult: (result: DemoResult | null) => void;
  settlement: HederaSettlementStatus;
  setSettlement: (status: HederaSettlementStatus) => void;
  settlementError: string;
  setSettlementError: (message: string) => void;
}

const PurchaseSessionContext =
  createContext<PurchaseSessionValue | null>(null);

export function PurchaseSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [result, setResult] = useState<DemoResult | null>(null);
  const [settlement, setSettlement] =
    useState<HederaSettlementStatus>("idle");
  const [settlementError, setSettlementError] = useState("");
  const value = useMemo(
    () => ({
      result,
      setResult,
      settlement,
      setSettlement,
      settlementError,
      setSettlementError,
    }),
    [result, settlement, settlementError],
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
