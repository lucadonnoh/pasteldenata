"use client";

import {
  ArrowUpRight,
  CarFront,
  Check,
  Clapperboard,
  Flower2,
  MapPin,
  Palette,
  Store,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import {
  type CSSProperties,
  useMemo,
  useState,
} from "react";

import {
  CATEGORIES,
  type Category,
  type PublicListing,
} from "@/src/domain";
import { formatUsd } from "@/src/money";

import styles from "./catalog-directory.module.css";

type CatalogFilter = "all" | Category;

const categoryIcons: Record<Category, LucideIcon> = {
  flowers: Flower2,
  cinema: Clapperboard,
  dinner: UtensilsCrossed,
  transport: CarFront,
  experience: Palette,
};

function categoryLabel(category: Category): string {
  return `${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}

function cityLabel(city: PublicListing["city"]): string {
  return `${city.charAt(0).toUpperCase()}${city.slice(1)}`;
}

function attributeLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (character) => character.toUpperCase());
}

function attributeValue(
  value: PublicListing["attributes"][string],
): string {
  if (Array.isArray(value)) return value.join(" · ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function CatalogDirectory({
  listings,
}: {
  listings: PublicListing[];
}) {
  const [activeCategory, setActiveCategory] =
    useState<CatalogFilter>("all");
  const visibleListings = useMemo(
    () =>
      activeCategory === "all"
        ? listings
        : listings.filter(
            (listing) => listing.category === activeCategory,
          ),
    [activeCategory, listings],
  );
  const sellerCount = new Set(
    listings.map((listing) => listing.sellerId),
  ).size;
  const cityNames = Array.from(
    new Set(listings.map((listing) => cityLabel(listing.city))),
  );

  return (
    <section className={styles.directory}>
      <header className={styles.hero}>
        <div>
          <span>MOCK PUBLIC MARKET · SANITIZED DISCOVERY DATA</span>
          <h1>What buyer agents can discover.</h1>
          <p>
            The mocked sellers expose these places, seats, and services
            to the planner. Only the same public metadata available to
            buyer agents is rendered here.
          </p>
        </div>

        <Link href="/">
          Ask the buyer agent
          <ArrowUpRight size={15} />
        </Link>
      </header>

      <div className={styles.marketSummary}>
        <div>
          <strong>{listings.length}</strong>
          <span>mock listings</span>
        </div>
        <div>
          <strong>{sellerCount}</strong>
          <span>mock sellers</span>
        </div>
        <div>
          <strong>{CATEGORIES.length}</strong>
          <span>categories</span>
        </div>
        <div className={styles.marketLocation}>
          <MapPin size={17} />
          <span>
            <small>MOCK MARKETS</small>
            {cityNames.join(" · ")}
          </span>
        </div>
      </div>

      <div className={styles.catalogControls}>
        <div>
          <span>Browse listings</span>
          <strong>{visibleListings.length} discoverable</strong>
        </div>

        <nav aria-label="Filter public listings by category">
          <button
            className={activeCategory === "all" ? styles.activeFilter : ""}
            type="button"
            aria-pressed={activeCategory === "all"}
            onClick={() => setActiveCategory("all")}
          >
            All
          </button>
          {CATEGORIES.map((category) => (
            <button
              className={
                activeCategory === category ? styles.activeFilter : ""
              }
              type="button"
              aria-pressed={activeCategory === category}
              key={category}
              onClick={() => setActiveCategory(category)}
            >
              {categoryLabel(category)}
            </button>
          ))}
        </nav>
      </div>

      <div className={styles.listingGrid} aria-live="polite">
        {visibleListings.map((listing, index) => {
          const CategoryIcon = categoryIcons[listing.category];
          const attributes = Object.entries(listing.attributes).slice(0, 2);

          return (
            <article
              className={styles.listingCard}
              data-category={listing.category}
              style={
                {
                  "--listing-delay": `${Math.min(index, 8) * 45}ms`,
                } as CSSProperties
              }
              key={listing.id}
            >
              <header>
                <span className={styles.categoryIcon}>
                  <CategoryIcon size={19} aria-hidden="true" />
                </span>
                <div>
                  <small>SELLER</small>
                  <strong>{listing.sellerName}</strong>
                </div>
                <b>
                  <i />
                  Mock listed
                </b>
              </header>

              <div className={styles.categoryLine}>
                <Store size={12} />
                {categoryLabel(listing.category)}
                <span>{cityLabel(listing.city)}</span>
              </div>

              <h2>{listing.offering}</h2>

              <dl className={styles.attributes}>
                {attributes.map(([key, value]) => (
                  <div key={key}>
                    <dt>{attributeLabel(key)}</dt>
                    <dd>{attributeValue(value)}</dd>
                  </div>
                ))}
              </dl>

              <div className={styles.listingTags}>
                {listing.tags.slice(0, 4).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>

              <footer>
                <div>
                  <span>EST. MARKET</span>
                  <strong>
                    {formatUsd(listing.estimatedMarketPriceCents)}
                  </strong>
                </div>
                <div>
                  <span>QUALITY</span>
                  <strong>{listing.quality}</strong>
                  <small>/ 100</small>
                </div>
                <b>
                  <Check size={11} />
                  Discoverable
                </b>
              </footer>
            </article>
          );
        })}
      </div>

      <footer className={styles.directoryNote}>
        <span>
          <Check size={12} />
          Sanitized mock discovery surface
        </span>
        Seller floors, salts, demand parameters, sold state, and buyer
        mandates are intentionally absent from this client payload.
      </footer>
    </section>
  );
}
