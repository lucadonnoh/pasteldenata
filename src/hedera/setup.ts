import "dotenv/config";
import { sellersForLocation } from "../catalog";
import { connectHedera } from "./client";
import { ensureInfra } from "./infra";
import { runtimeDataDirectory } from "../server/runtime-data";

async function main() {
  const requestedMarket = process.argv.slice(2).join(" ").trim() || "Lisbon";
  const sellers = sellersForLocation(requestedMarket);
  const ctx = connectHedera();
  try {
    const infra = await ensureInfra(ctx, sellers);
    console.log("\nHedera testnet infrastructure ready\n");
    console.log(`Prepared market      ${requestedMarket}`);
    console.log(`NATA payment token   ${infra.paymentTokenId}`);
    console.log(`Claim NFT collection ${infra.claimTokenId}`);
    console.log(`Buyer account        ${infra.buyer.accountId}`);
    console.log(`Seller accounts      ${Object.keys(infra.sellers).length}`);
    console.log(
      `\nDetails saved to ${runtimeDataDirectory()}/hedera-infra.json (not committed).\n`,
    );
  } finally {
    ctx.client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nSetup failed: ${message}\n`);
  process.exitCode = 1;
});
