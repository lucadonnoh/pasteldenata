// Pure shared timing policy: safe to import in both the Hedera coordinator and
// the browser's live explanation without bundling the Hedera SDK client-side.
export const MARKET_MIN_AUCTION_MS = 40_000;
export const MARKET_QUIET_CLOSE_MS = 8_000;
export const MARKET_HARD_CLOSE_MS = 50_000;
export const MARKET_CLAIM_WINDOW_MS = 30_000;

export function expectedMarketCloseAtMs(
  openingConsensusMs: number,
  latestBidConsensusMs: number,
): number {
  return Math.min(
    openingConsensusMs + MARKET_HARD_CLOSE_MS,
    Math.max(
      openingConsensusMs + MARKET_MIN_AUCTION_MS,
      latestBidConsensusMs + MARKET_QUIET_CLOSE_MS,
    ),
  );
}
