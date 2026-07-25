export const TESTNET_MIRROR_BASE = "https://testnet.mirrornode.hedera.com";

export interface LiveBid {
  listingId: string;
  sellerId: string;
  sellerName: string;
  offering: string;
  amountCents: number;
  quality: number;
  tags: string[];
  payerAccountId: string;
  sequenceNumber: number;
}

interface MirrorMessage {
  message: string;
  payer_account_id: string;
  sequence_number: number;
}

export interface AuthorizedSeller {
  sellerId: string;
  accountId: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveCents(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validQuality(value: unknown): value is number {
  return (
    Number.isFinite(value) &&
    Number(value) >= 0 &&
    Number(value) <= 100
  );
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => nonEmptyString(item))
  );
}

function parseMessage(message: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(message, "base64").toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function allTopicMessages(
  mirrorBaseUrl: string,
  topicId: string,
): Promise<MirrorMessage[]> {
  const messages: MirrorMessage[] = [];
  let url = `${mirrorBaseUrl}/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Mirror Node returned ${response.status} for ${topicId}.`);
    }
    const data = (await response.json()) as {
      messages?: MirrorMessage[];
      links?: { next?: string | null };
    };
    if (!Array.isArray(data.messages)) {
      throw new Error(`Mirror Node returned malformed messages for ${topicId}.`);
    }
    messages.push(...data.messages);
    const next = data.links?.next;
    url = next ? new URL(next, mirrorBaseUrl).toString() : "";
  }
  return messages;
}

/**
 * Read authenticated live reverse-auction bids. A bid is accepted only when
 * its schema is valid and Mirror Node identifies its payer as the registered
 * account for that exact seller listing.
 */
export async function fetchTopicBids(
  mirrorBaseUrl: string,
  topicId: string,
  auctionId: string,
  authorizedListings: ReadonlyMap<string, AuthorizedSeller>,
): Promise<LiveBid[]> {
  const bids: LiveBid[] = [];
  for (const item of await allTopicMessages(mirrorBaseUrl, topicId)) {
    const parsed = parseMessage(item.message);
    if (
      !parsed ||
      parsed.type !== "BID" ||
      parsed.auctionId !== auctionId ||
      !nonEmptyString(parsed.listingId) ||
      !nonEmptyString(parsed.sellerId) ||
      !nonEmptyString(parsed.sellerName) ||
      !nonEmptyString(parsed.offering) ||
      !positiveCents(parsed.amountCents) ||
      !validQuality(parsed.quality) ||
      !stringArray(parsed.tags)
    ) {
      continue;
    }
    const authorized = authorizedListings.get(parsed.listingId);
    if (
      !authorized ||
      authorized.sellerId !== parsed.sellerId ||
      authorized.accountId !== item.payer_account_id
    ) {
      continue;
    }
    bids.push({
      listingId: parsed.listingId,
      sellerId: parsed.sellerId,
      sellerName: parsed.sellerName,
      offering: parsed.offering,
      amountCents: parsed.amountCents,
      quality: parsed.quality,
      tags: parsed.tags,
      payerAccountId: item.payer_account_id,
      sequenceNumber: item.sequence_number,
    });
  }
  return bids;
}

/** The standing lowest offer per listing, given the full valid bid history. */
export function standingOffers(bids: LiveBid[]): Map<string, LiveBid> {
  const best = new Map<string, LiveBid>();
  for (const bid of bids) {
    const current = best.get(bid.listingId);
    if (!current || bid.amountCents < current.amountCents) {
      best.set(bid.listingId, bid);
    }
  }
  return best;
}

export interface AscendingBid {
  bidder: string;
  amountCents: number;
  sequenceNumber: number;
}

export interface ItemSettlement {
  bidder: string;
  amountCents: number;
  transactionId: string;
}

export interface ItemState {
  bids: AscendingBid[];
  settlement?: ItemSettlement;
}

/**
 * Read an ascending item auction. BID identities must match the actual payer,
 * and SETTLED is accepted only from the marketplace clearing account.
 */
export async function fetchItemState(
  mirrorBaseUrl: string,
  topicId: string,
  itemId: string,
  settlementPayerAccountId: string,
): Promise<ItemState> {
  const bids: AscendingBid[] = [];
  let settlement: ItemSettlement | undefined;
  for (const item of await allTopicMessages(mirrorBaseUrl, topicId)) {
    const parsed = parseMessage(item.message);
    if (!parsed || parsed.itemId !== itemId) continue;
    if (
      parsed.type === "BID" &&
      nonEmptyString(parsed.bidder) &&
      parsed.bidder === item.payer_account_id &&
      positiveCents(parsed.amountCents)
    ) {
      bids.push({
        bidder: parsed.bidder,
        amountCents: parsed.amountCents,
        sequenceNumber: item.sequence_number,
      });
    }
    if (
      parsed.type === "SETTLED" &&
      item.payer_account_id === settlementPayerAccountId &&
      nonEmptyString(parsed.bidder) &&
      positiveCents(parsed.amountCents) &&
      nonEmptyString(parsed.transactionId)
    ) {
      settlement = {
        bidder: parsed.bidder,
        amountCents: parsed.amountCents,
        transactionId: parsed.transactionId,
      };
    }
  }
  return { bids, ...(settlement ? { settlement } : {}) };
}

/** Highest bid wins; a tie goes to the earlier consensus sequence. */
export function ascendingLeader(
  bids: AscendingBid[],
): AscendingBid | undefined {
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
