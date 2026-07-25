export interface OutcomeListing {
  itemId: string;
  category: string;
}

export interface OutcomeBid {
  yours: boolean;
}

export interface OutcomeAccessBlock {
  buyerName: string;
  category: string;
  itemId: string;
}

/**
 * Distinguish a real auction loss from seller-side admission failure.
 * A category counts as access-blocked only when every published listing
 * rejected this buyer and no authenticated bid from its agent exists.
 */
export function wasPreventedFromBidding({
  buyerName,
  category,
  listings,
  bidsByItem,
  blocks,
}: {
  buyerName: string;
  category: string;
  listings: readonly OutcomeListing[];
  bidsByItem: Readonly<Record<string, readonly OutcomeBid[]>>;
  blocks: readonly OutcomeAccessBlock[];
}): boolean {
  const categoryListings = listings.filter(
    (listing) => listing.category === category,
  );
  if (categoryListings.length === 0) return false;

  const placedAuthenticatedBid = categoryListings.some((listing) =>
    (bidsByItem[listing.itemId] ?? []).some((bid) => bid.yours),
  );
  if (placedAuthenticatedBid) return false;

  const blockedItems = new Set(
    blocks
      .filter(
        (block) =>
          block.buyerName === buyerName && block.category === category,
      )
      .map((block) => block.itemId),
  );
  return categoryListings.every((listing) =>
    blockedItems.has(listing.itemId),
  );
}
