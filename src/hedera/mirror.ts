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
  consensus_timestamp?: string;
}

export interface AuthorizedSeller {
  sellerId: string;
  accountId: string;
}

const MIRROR_FETCH_ATTEMPTS = 5;
const MIRROR_FETCH_TIMEOUT_MS = 5_000;
const MIRROR_RETRY_BASE_MS = 250;
const MIRROR_RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableMirrorStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MIRROR_RETRY_MAX_MS);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.min(
        Math.max(0, dateMs - Date.now()),
        MIRROR_RETRY_MAX_MS,
      );
    }
  }
  return Math.min(
    MIRROR_RETRY_BASE_MS * 2 ** attempt,
    MIRROR_RETRY_MAX_MS,
  );
}

async function fetchMirrorPage(
  url: string,
  topicId: string,
): Promise<{
  messages: MirrorMessage[];
  links?: { next?: string | null };
}> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MIRROR_FETCH_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(MIRROR_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        const error = new Error(
          `Mirror Node returned ${response.status} for ${topicId}.`,
        );
        if (!retryableMirrorStatus(response.status)) throw error;
        lastError = error;
      } else {
        const data = (await response.json()) as {
          messages?: MirrorMessage[];
          links?: { next?: string | null };
        };
        if (!Array.isArray(data.messages)) {
          lastError = new Error(
            `Mirror Node returned malformed messages for ${topicId}.`,
          );
        } else {
          return {
            messages: data.messages,
            ...(data.links ? { links: data.links } : {}),
          };
        }
      }
    } catch (error) {
      if (
        response &&
        !response.ok &&
        !retryableMirrorStatus(response.status)
      ) {
        throw error;
      }
      lastError = error;
    }
    if (attempt + 1 < MIRROR_FETCH_ATTEMPTS) {
      await sleep(retryDelayMs(response, attempt));
    }
  }
  throw (
    lastError ??
    new Error(`Mirror Node did not return messages for ${topicId}.`)
  );
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
    const data = await fetchMirrorPage(url, topicId);
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
  consensusTimestampMs: number;
}

export interface ItemClosure {
  sequenceNumber: number;
  consensusTimestampMs: number;
}

export interface ItemForfeiture {
  bidder: string;
  amountCents: number;
  sequenceNumber: number;
  consensusTimestampMs: number;
}

export interface ItemOpening {
  sequenceNumber: number;
  consensusTimestampMs: number;
}

export interface ItemSettlement {
  bidder: string;
  amountCents: number;
  transactionId: string;
}

export interface ItemState {
  bids: AscendingBid[];
  opening?: ItemOpening;
  closure?: ItemClosure;
  forfeitures: ItemForfeiture[];
  settlement?: ItemSettlement;
}

function consensusTimestampMs(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{1,10}\.\d{1,9}$/.test(value)
  ) {
    return undefined;
  }
  const [seconds, nanos = ""] = value.split(".");
  const milliseconds =
    Number(seconds) * 1000 +
    Number(nanos.padEnd(9, "0").slice(0, 3));
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/**
 * Read an ascending item auction. BID identities must match the actual payer.
 * CLOSED, FORFEITED, and SETTLED are accepted only from marketplace clearing;
 * bids ordered after the first authenticated close do not participate in the
 * result.
 */
export async function fetchItemState(
  mirrorBaseUrl: string,
  topicId: string,
  itemId: string,
  settlementPayerAccountId: string,
): Promise<ItemState> {
  const bids: AscendingBid[] = [];
  let opening: ItemOpening | undefined;
  let closure: ItemClosure | undefined;
  const forfeitures: ItemForfeiture[] = [];
  let settlement: ItemSettlement | undefined;
  for (const item of await allTopicMessages(mirrorBaseUrl, topicId)) {
    const parsed = parseMessage(item.message);
    if (!parsed || parsed.itemId !== itemId) continue;
    const timestampMs = consensusTimestampMs(item.consensus_timestamp);
    if (
      !opening &&
      parsed.type === "LISTED" &&
      item.payer_account_id === settlementPayerAccountId &&
      timestampMs !== undefined
    ) {
      opening = {
        sequenceNumber: item.sequence_number,
        consensusTimestampMs: timestampMs,
      };
    }
    if (
      !closure &&
      parsed.type === "BID" &&
      nonEmptyString(parsed.bidder) &&
      parsed.bidder === item.payer_account_id &&
      positiveCents(parsed.amountCents) &&
      timestampMs !== undefined
    ) {
      bids.push({
        bidder: parsed.bidder,
        amountCents: parsed.amountCents,
        sequenceNumber: item.sequence_number,
        consensusTimestampMs: timestampMs,
      });
    }
    if (
      !closure &&
      parsed.type === "CLOSED" &&
      item.payer_account_id === settlementPayerAccountId &&
      timestampMs !== undefined
    ) {
      closure = {
        sequenceNumber: item.sequence_number,
        consensusTimestampMs: timestampMs,
      };
    }
    if (
      closure &&
      parsed.type === "FORFEITED" &&
      item.payer_account_id === settlementPayerAccountId &&
      nonEmptyString(parsed.bidder) &&
      positiveCents(parsed.amountCents) &&
      timestampMs !== undefined
    ) {
      forfeitures.push({
        bidder: parsed.bidder,
        amountCents: parsed.amountCents,
        sequenceNumber: item.sequence_number,
        consensusTimestampMs: timestampMs,
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
  return {
    bids,
    ...(opening ? { opening } : {}),
    ...(closure ? { closure } : {}),
    forfeitures,
    ...(settlement ? { settlement } : {}),
  };
}

/**
 * Fixed bidder ranking for a closed ascending auction. A bidder occupies one
 * position using its highest valid bid, so forfeiting a bidder cannot expose
 * one of that same account's older bids as the next winner.
 */
export function ascendingRanking(
  bids: AscendingBid[],
): AscendingBid[] {
  const bestByBidder = new Map<string, AscendingBid>();
  for (const bid of bids) {
    const current = bestByBidder.get(bid.bidder);
    if (
      !current ||
      bid.amountCents > current.amountCents ||
      (bid.amountCents === current.amountCents &&
        bid.sequenceNumber < current.sequenceNumber)
    ) {
      bestByBidder.set(bid.bidder, bid);
    }
  }
  return [...bestByBidder.values()].sort(
    (left, right) =>
      right.amountCents - left.amountCents ||
      left.sequenceNumber - right.sequenceNumber ||
      left.bidder.localeCompare(right.bidder),
  );
}

/** Highest bidder under the fixed per-account ranking. */
export function ascendingLeader(
  bids: AscendingBid[],
): AscendingBid | undefined {
  return ascendingRanking(bids)[0];
}
