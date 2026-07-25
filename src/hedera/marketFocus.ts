export interface AuctionFocusActivity {
  itemId: string;
  category: string;
  event: {
    type: string;
    sequenceNumber: number;
    consensusTimestamp?: string;
  };
}

function consensusTimeMs(timestamp?: string): number {
  if (!timestamp) return 0;
  const [seconds, nanos = "0"] = timestamp.split(".");
  const secondsNumber = Number(seconds);
  const nanosNumber = Number(nanos.padEnd(9, "0").slice(0, 9));
  if (!Number.isFinite(secondsNumber) || !Number.isFinite(nanosNumber)) {
    return 0;
  }
  return secondsNumber * 1000 + nanosNumber / 1_000_000;
}

/**
 * Select the newest authenticated bid across the buyer's visible market.
 * Input order is deliberately irrelevant so delayed Mirror Node responses
 * cannot leave the UI following an older topic.
 */
export function latestBidActivity<T extends AuctionFocusActivity>(
  activity: readonly T[],
  visibleCategories: ReadonlySet<string>,
): T | undefined {
  return activity.reduce<T | undefined>((latest, candidate) => {
    if (
      candidate.event.type !== "BID" ||
      !visibleCategories.has(candidate.category)
    ) {
      return latest;
    }
    if (!latest) return candidate;

    const candidateTime = consensusTimeMs(
      candidate.event.consensusTimestamp,
    );
    const latestTime = consensusTimeMs(latest.event.consensusTimestamp);
    if (candidateTime !== latestTime) {
      return candidateTime > latestTime ? candidate : latest;
    }
    return candidate.event.sequenceNumber > latest.event.sequenceNumber
      ? candidate
      : latest;
  }, undefined);
}
