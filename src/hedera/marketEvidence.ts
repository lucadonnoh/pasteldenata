export interface PublicMirrorMessage {
  message: string;
  payer_account_id: string;
  sequence_number: number;
}

export type MarketLedgerEvent =
  | {
      type: "LISTED";
      sequenceNumber: number;
      payerAccountId: string;
      humanPolicy?: "open" | "one-per-human";
      authorizationIssuerPublicKey?: string;
    }
  | {
      type: "AUTHORIZED";
      sequenceNumber: number;
      payerAccountId: string;
      bidder: string;
      nullifier: string;
      quota: number;
      expiresAt: number;
      issuerPublicKey: string;
      signature: string;
      yours: boolean;
    }
  | {
      type: "BID";
      sequenceNumber: number;
      payerAccountId: string;
      bidder: string;
      amountCents: number;
      yours: boolean;
    }
  | {
      type: "CLOSED";
      sequenceNumber: number;
      payerAccountId: string;
    }
  | {
      type: "FORFEITED";
      sequenceNumber: number;
      payerAccountId: string;
      bidder: string;
      amountCents: number;
      yours: boolean;
    }
  | {
      type: "SETTLED";
      sequenceNumber: number;
      payerAccountId: string;
      bidder: string;
      amountCents: number;
      transactionId: string;
      claimNftSerial?: number;
      yours: boolean;
    };

export interface MarketBid {
  bidder: string;
  amountCents: number;
  sequenceNumber: number;
  /** True when the bidder is one of the user's own agents. */
  yours: boolean;
}

type FetchMirror = (url: string) => Promise<Response>;
const fetchMirror: FetchMirror = (url) =>
  fetch(url, { signal: AbortSignal.timeout(10_000) });

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveCents(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function decodeMirrorMessageBody(
  message: string,
): Record<string, unknown> | undefined {
  try {
    const bytes = Uint8Array.from(atob(message), (character) =>
      character.charCodeAt(0),
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Mirror Node caps topic responses at 100 entries. Follow every `links.next`
 * page so the live cockpit cannot freeze on the first page of a busy auction.
 */
export async function fetchAllMirrorTopicMessages(
  mirrorBaseUrl: string,
  topicId: string,
  request: FetchMirror = fetchMirror,
): Promise<PublicMirrorMessage[]> {
  const messages: PublicMirrorMessage[] = [];
  const mirrorOrigin = new URL(mirrorBaseUrl).origin;
  let url =
    `${mirrorBaseUrl}/api/v1/topics/${encodeURIComponent(topicId)}` +
    "/messages?limit=100&order=asc";

  while (url) {
    const response = await request(url);
    if (!response.ok) {
      throw new Error(`Mirror Node returned ${response.status} for ${topicId}.`);
    }
    const data = (await response.json()) as {
      messages?: PublicMirrorMessage[];
      links?: { next?: string | null };
    };
    if (!Array.isArray(data.messages)) {
      throw new Error(`Mirror Node returned malformed messages for ${topicId}.`);
    }
    messages.push(...data.messages);

    const next = data.links?.next;
    if (!next) break;
    const nextUrl = new URL(next, mirrorBaseUrl);
    if (nextUrl.origin !== mirrorOrigin) {
      throw new Error("Mirror Node pagination changed origin.");
    }
    url = nextUrl.toString();
  }

  return messages;
}

/**
 * Build the browser's auditable view from the same payer-bound lifecycle used
 * by settlement: bids are accepted only from their named payer and only before
 * the first clearing-authenticated close; lifecycle messages must be paid by
 * the clearing account.
 */
export function parseMarketLedgerEvents(
  messages: PublicMirrorMessage[],
  itemId: string,
  clearingAccountId: string,
  yourAgentIds: ReadonlySet<string>,
): MarketLedgerEvent[] {
  const events: MarketLedgerEvent[] = [];
  let closed = false;
  let authorizationIssuerPublicKey: string | undefined;

  for (const item of messages) {
    const body = decodeMirrorMessageBody(item.message);
    if (!body || body.itemId !== itemId) continue;

    if (
      body.type === "LISTED" &&
      item.payer_account_id === clearingAccountId
    ) {
      authorizationIssuerPublicKey = nonEmptyString(
        body.authorizationIssuerPublicKey,
      )
        ? body.authorizationIssuerPublicKey
        : undefined;
      events.push({
        type: "LISTED",
        sequenceNumber: item.sequence_number,
        payerAccountId: item.payer_account_id,
        ...(body.humanPolicy === "open" ||
        body.humanPolicy === "one-per-human"
          ? { humanPolicy: body.humanPolicy }
          : {}),
        ...(authorizationIssuerPublicKey
          ? { authorizationIssuerPublicKey }
          : {}),
      });
      continue;
    }

    if (
      body.type === "BID" &&
      !closed &&
      nonEmptyString(body.bidder) &&
      body.bidder === item.payer_account_id &&
      positiveCents(body.amountCents)
    ) {
      events.push({
        type: "BID",
        sequenceNumber: item.sequence_number,
        payerAccountId: item.payer_account_id,
        bidder: body.bidder,
        amountCents: body.amountCents,
        yours: yourAgentIds.has(body.bidder),
      });
      continue;
    }

    if (
      body.type === "AUTHORIZED" &&
      item.payer_account_id === clearingAccountId &&
      nonEmptyString(body.bidder) &&
      nonEmptyString(body.nullifier) &&
      Number.isSafeInteger(body.quota) &&
      Number(body.quota) > 0 &&
      Number.isSafeInteger(body.expiresAt) &&
      Number(body.expiresAt) > 0 &&
      nonEmptyString(body.issuerPublicKey) &&
      body.issuerPublicKey === authorizationIssuerPublicKey &&
      nonEmptyString(body.signature)
    ) {
      events.push({
        type: "AUTHORIZED",
        sequenceNumber: item.sequence_number,
        payerAccountId: item.payer_account_id,
        bidder: body.bidder,
        nullifier: body.nullifier,
        quota: Number(body.quota),
        expiresAt: Number(body.expiresAt),
        issuerPublicKey: body.issuerPublicKey,
        signature: body.signature,
        yours: yourAgentIds.has(body.bidder),
      });
      continue;
    }

    if (
      body.type === "CLOSED" &&
      !closed &&
      item.payer_account_id === clearingAccountId
    ) {
      closed = true;
      events.push({
        type: "CLOSED",
        sequenceNumber: item.sequence_number,
        payerAccountId: item.payer_account_id,
      });
      continue;
    }

    if (
      body.type === "FORFEITED" &&
      closed &&
      item.payer_account_id === clearingAccountId &&
      nonEmptyString(body.bidder) &&
      positiveCents(body.amountCents)
    ) {
      events.push({
        type: "FORFEITED",
        sequenceNumber: item.sequence_number,
        payerAccountId: item.payer_account_id,
        bidder: body.bidder,
        amountCents: body.amountCents,
        yours: yourAgentIds.has(body.bidder),
      });
      continue;
    }

    if (
      body.type === "SETTLED" &&
      item.payer_account_id === clearingAccountId &&
      nonEmptyString(body.bidder) &&
      positiveCents(body.amountCents) &&
      nonEmptyString(body.transactionId)
    ) {
      events.push({
        type: "SETTLED",
        sequenceNumber: item.sequence_number,
        payerAccountId: item.payer_account_id,
        bidder: body.bidder,
        amountCents: body.amountCents,
        transactionId: body.transactionId,
        ...(Number.isSafeInteger(body.claimNftSerial) &&
        Number(body.claimNftSerial) > 0
          ? { claimNftSerial: Number(body.claimNftSerial) }
          : {}),
        yours: yourAgentIds.has(body.bidder),
      });
    }
  }

  return events;
}

export function marketBidsFromEvents(
  events: MarketLedgerEvent[],
): MarketBid[] {
  return events
    .filter((event): event is Extract<MarketLedgerEvent, { type: "BID" }> =>
      event.type === "BID",
    )
    .map(({ bidder, amountCents, sequenceNumber, yours }) => ({
      bidder,
      amountCents,
      sequenceNumber,
      yours,
    }));
}

export function marketSettlementFromEvents(
  events: MarketLedgerEvent[],
): Extract<MarketLedgerEvent, { type: "SETTLED" }> | undefined {
  return events.findLast(
    (event): event is Extract<MarketLedgerEvent, { type: "SETTLED" }> =>
      event.type === "SETTLED",
  );
}
