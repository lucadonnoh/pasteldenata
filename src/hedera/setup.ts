import "dotenv/config";
import { MOCK_SELLERS } from "../catalog";
import { connectHedera } from "./client";
import { ensureInfra } from "./infra";

async function main() {
  const ctx = connectHedera();
  try {
    const infra = await ensureInfra(ctx, MOCK_SELLERS);
    console.log("\nHedera testnet infrastructure ready\n");
    console.log(`NATA payment token   ${infra.paymentTokenId}`);
    console.log(`Claim NFT collection ${infra.claimTokenId}`);
    console.log(`Buyer account        ${infra.buyer.accountId}`);
    console.log(`Seller accounts      ${Object.keys(infra.sellers).length}`);
    console.log("\nDetails saved to hedera-infra.json (not committed).\n");
  } finally {
    ctx.client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nSetup failed: ${message}\n`);
  process.exitCode = 1;
});
