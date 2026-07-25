"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

import type { DemoResult } from "@/src/domain";

interface PurchaseSessionValue {
  result: DemoResult | null;
  setResult: (result: DemoResult | null) => void;
}

const PurchaseSessionContext =
  createContext<PurchaseSessionValue | null>(null);

export function PurchaseSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [result, setResult] = useState<DemoResult | null>(null);
  const value = useMemo(() => ({ result, setResult }), [result]);

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
