import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { WorldVerify } from "@/components/world-verify";

export const metadata: Metadata = {
  title: "Pastel — human-backed agents",
  description:
    "Register your buyer identity agent with World ID via AgentKit.",
};

export default function WorldPage() {
  return (
    <main className="world-page">
      <div className="world-page-content">
        <Link className="world-back-link" href="/">
          <ArrowLeft size={14} aria-hidden="true" />
          Back to private intent
        </Link>
        <WorldVerify />
      </div>
    </main>
  );
}
