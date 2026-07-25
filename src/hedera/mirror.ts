export const TESTNET_MIRROR_BASE = "https://testnet.mirrornode.hedera.com";

export interface LiveBid {
  sellerId: string;
  sellerName: string;
  offering: string;
  amountCents: number;
  quality: number;
  tags: string[];
  sequenceNumber: number;
}

interface MirrorMessage {
  message: string;
  sequence_number: number;
}

/**
 * Read all BID messages from an auction topic, oldest first. Mirror Node
 * lags consensus by a couple of seconds; both the bidding sellers and the
 * buying leaf work from this same public view.
 */
export async function fetchTopicBids(
  mirrorBaseUrl: string,
  topicId: string,
  auctionId: string,
): Promise<LiveBid[]> {
  const bids: LiveBid[] = [];
  let url = `${mirrorBaseUrl}/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Mirror Node returned ${response.status} for ${topicId}.`);
    }
    const data = (await response.json()) as {
      messages: MirrorMessage[];
      links?: { next?: string | null };
    };
    for (const item of data.messages) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(Buffer.from(item.message, "base64").toString("utf8"));
      } catch {
        continue;
      }
      if (parsed.type !== "BID" || parsed.auctionId !== auctionId) continue;
      bids.push({
        sellerId: String(parsed.sellerId),
        sellerName: String(parsed.sellerName),
        offering: String(parsed.offering),
        amountCents: Number(parsed.amountCents),
        quality: Number(parsed.quality),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        sequenceNumber: item.sequence_number,
      });
    }
    const next = data.links?.next;
    url = next ? `${mirrorBaseUrl}${next}` : "";
  }
  return bids;
}

/** The standing (lowest) offer per seller, given the full bid history. */
export function standingOffers(bids: LiveBid[]): Map<string, LiveBid> {
  const best = new Map<string, LiveBid>();
  for (const bid of bids) {
    const current = best.get(bid.sellerId);
    if (!current || bid.amountCents < current.amountCents) {
      best.set(bid.sellerId, bid);
    }
  }
  return best;
}

export interface AscendingBid {
  bidder: string;
  amountCents: number;
  sequenceNumber: number;
}

export interface ItemState {
  bids: AscendingBid[];
  settled: boolean;
}

/**
 * Read an ascending (market-mode) item auction: buyer bids plus whether a
 * SETTLED message has closed it.
 */
export async function fetchItemState(
  mirrorBaseUrl: string,
  topicId: string,
  itemId: string,
): Promise<ItemState> {
  const bids: AscendingBid[] = [];
  let settled = false;
  let url = `${mirrorBaseUrl}/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Mirror Node returned ${response.status} for ${topicId}.`);
    }
    const data = (await response.json()) as {
      messages: MirrorMessage[];
      links?: { next?: string | null };
    };
    for (const item of data.messages) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(Buffer.from(item.message, "base64").toString("utf8"));
      } catch {
        continue;
      }
      if (parsed.itemId !== itemId && parsed.auctionId !== itemId) continue;
      if (parsed.type === "SETTLED") settled = true;
      if (parsed.type === "BID") {
        bids.push({
          bidder: String(parsed.bidder),
          amountCents: Number(parsed.amountCents),
          sequenceNumber: item.sequence_number,
        });
      }
    }
    const next = data.links?.next;
    url = next ? `${mirrorBaseUrl}${next}` : "";
  }
  return { bids, settled };
}

/** Highest bid wins; a tie goes to the earlier consensus sequence. */
export function ascendingLeader(bids: AscendingBid[]): AscendingBid | undefined {
  let leader: AscendingBid | undefined;
  for (const bid of bids) {
    if (
      !leader ||
      bid.amountCents > leader.amountCents ||
      (bid.amountCents === leader.amountCents &&
        bid.sequenceNumber < leader.sequenceNumber)
    ) {
      leader = bid;
    }
  }
  return leader;
}
