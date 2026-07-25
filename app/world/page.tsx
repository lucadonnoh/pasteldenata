import type { Metadata } from "next";

import { WorldVerify } from "@/components/world-verify";

export const metadata: Metadata = {
  title: "Pastel — human-backed agents",
  description:
    "Register your buyer identity agent with World ID via AgentKit.",
};

export default function WorldPage() {
  return (
    <main className="world-page">
      <WorldVerify />
    </main>
  );
}
