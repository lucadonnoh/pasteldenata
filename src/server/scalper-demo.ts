import { MockAgentBook, WorldGateway } from "./world-gateway";

/**
 * The adversarial demo for World AgentKit: a scalper launches ten bidding
 * agents at a one-per-human listing. AgentKit resolves every wallet to the
 * same anonymous human, the gateway's auction-scoped nullifier collapses
 * them into a single allocation, and nine agents are refused before they
 * can bid. The open listing next to it accepts everyone — human policy is
 * the seller's choice, not mandatory identity theater.
 *
 *   npm run demo:scalper
 */

function line(label: string, value: string) {
  console.log(`${label.padEnd(22)} ${value}`);
}

async function main() {
  console.log("\nPASTEL DE NATA — HUMAN-GATED AUCTIONS (World AgentKit)\n");

  const book = new MockAgentBook();
  // Honest buyer: one identity agent, verified via World App.
  book.registerAgent("0xAliceIdentityAgent", "alice");
  // The scalper registered two identity agents — but AgentKit resolves both
  // to the same anonymous human, because that is what they are.
  book.registerAgent("0xScalperIdentityA", "scalper");
  book.registerAgent("0xScalperIdentityB", "scalper");
  const gateway = new WorldGateway(book);

  console.log("LISTINGS");
  line("Cinema São Jorge", "Balcony B 9–10 · policy: ONE PER HUMAN");
  line("Bloom LX", "Wildflower bouquet · policy: OPEN (no check)");
  console.log();

  console.log("SCALPER launches 10 bidding agents at the cinema seats…");
  let issued = 0;
  let rejected = 0;
  for (let i = 0; i < 10; i++) {
    const identityAgent =
      i % 2 === 0 ? "0xScalperIdentityA" : "0xScalperIdentityB";
    const result = await gateway.enroll({
      auctionId: "item_cinema_sao_jorge_b9",
      identityAgent,
      leafWallet: `0.0.90${String(i).padStart(2, "0")}`,
    });
    const wallet = `0.0.90${String(i).padStart(2, "0")}`;
    if (result.ok) {
      issued += 1;
      console.log(
        `  ${wallet} · pass issued · nullifier ${result.pass?.nullifier.slice(0, 10)}…`,
      );
    } else {
      rejected += 1;
      console.log(`  ${wallet} · REFUSED · ${result.reason}`);
    }
  }
  console.log();

  console.log("ALICE enrolls one agent at the same listing…");
  const alice = await gateway.enroll({
    auctionId: "item_cinema_sao_jorge_b9",
    identityAgent: "0xAliceIdentityAgent",
    leafWallet: "0.0.9100",
  });
  console.log(
    `  0.0.9100 · ${alice.ok ? `pass issued · nullifier ${alice.pass?.nullifier.slice(0, 10)}…` : alice.reason}`,
  );
  console.log();

  console.log("A BOT (no World registration) tries…");
  const bot = await gateway.enroll({
    auctionId: "item_cinema_sao_jorge_b9",
    identityAgent: "0xPlainBot",
    leafWallet: "0.0.9200",
  });
  console.log(`  0.0.9200 · ${bot.ok ? "pass issued" : `REFUSED · ${bot.reason}`}`);
  console.log();

  console.log("THE OPEN LISTING (Bloom LX) accepts all comers — no gateway involved.\n");

  console.log("RESULT");
  line("Scalper agents", "10 wallets → 1 underlying human");
  line("Passes issued", String(issued));
  line("Sybil agents blocked", String(rejected));
  line("Honest human", alice.ok ? "1 pass, 1 allocation" : "error");
  line("Unbacked bot", bot.ok ? "error" : "refused outright");
  line(
    "Privacy",
    "sellers see auction-scoped nullifiers; the humanId never leaves the gateway",
  );
  console.log();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
