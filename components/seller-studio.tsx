"use client";

import {
  Check,
  ChevronDown,
  Eye,
  ImagePlus,
  MapPin,
  Package,
} from "lucide-react";
import { FormEvent, useState } from "react";

const categories = ["Dining", "Experience", "Cinema", "Flowers", "Transport"];

export function SellerStudio() {
  const [category, setCategory] = useState(categories[0] ?? "");
  const [title, setTitle] = useState("Sunset dinner for two");
  const [price, setPrice] = useState("85");
  const [location, setLocation] = useState("Lisbon");
  const [humanPolicy, setHumanPolicy] = useState<"open" | "one-per-human">(
    "one-per-human",
  );
  const [availability, setAvailability] = useState("4");
  const [description, setDescription] = useState(
    "A seasonal tasting menu served by the window, with a welcome drink included.",
  );
  const [saved, setSaved] = useState(false);

  function savePreview(event: FormEvent) {
    event.preventDefault();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <section className="seller-workspace" aria-labelledby="seller-title">
      <div className="seller-heading">
        <div>
          <span className="eyebrow">SELLER STUDIO</span>
          <h1 id="seller-title">Create an offer.</h1>
          <p>Shape what buyer agents will discover in the market.</p>
        </div>
        <div className="draft-state">
          <span />
          Draft
        </div>
      </div>

      <div className="seller-layout">
        <form className="offer-editor liquid-surface" onSubmit={savePreview}>
          <div className="editor-topline">
            <span>Offer details</span>
            <span>01 / 01</span>
          </div>

          <label className="hero-field">
            <span>WHAT ARE YOU OFFERING?</span>
            <input
              value={title}
              maxLength={70}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Name your offer"
            />
          </label>

          <div className="category-field">
            <span className="field-caption">CATEGORY</span>
            <div className="category-options">
              {categories.map((item) => (
                <button
                  className={category === item ? "active" : ""}
                  type="button"
                  key={item}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="category-field">
            <span className="field-caption">BUYER POLICY</span>
            <div className="category-options">
              <button
                className={humanPolicy === "one-per-human" ? "active" : ""}
                type="button"
                onClick={() => setHumanPolicy("one-per-human")}
                title="Bidders must be backed by a verified human (World ID); one allocation per human"
              >
                1 per human
              </button>
              <button
                className={humanPolicy === "open" ? "active" : ""}
                type="button"
                onClick={() => setHumanPolicy("open")}
                title="No identity check — any agent may bid"
              >
                open
              </button>
            </div>
          </div>

          <div className="compact-fields">
            <label>
              <span className="field-caption">OPENING FLOOR</span>
              <div className="input-with-prefix">
                <b>€</b>
                <input
                  inputMode="decimal"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  aria-label="Offer price"
                />
              </div>
            </label>

            <label>
              <span className="field-caption">AVAILABLE</span>
              <div className="input-with-icon">
                <Package size={14} />
                <input
                  inputMode="numeric"
                  value={availability}
                  onChange={(event) => setAvailability(event.target.value)}
                  aria-label="Available quantity"
                />
              </div>
            </label>

            <label>
              <span className="field-caption">LOCATION</span>
              <div className="input-with-icon">
                <MapPin size={14} />
                <input
                  required
                  value={location}
                  placeholder="City"
                  onChange={(event) => setLocation(event.target.value)}
                  aria-label="Listing city"
                />
              </div>
            </label>
          </div>

          <label className="description-field">
            <span className="field-caption">SHORT DESCRIPTION</span>
            <textarea
              value={description}
              maxLength={180}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
            <b>{description.length}/180</b>
          </label>

          <div className="editor-footer">
            <button className="media-button" type="button">
              <ImagePlus size={15} />
              Add cover
            </button>
            <button className="publish-button" type="submit">
              {saved ? (
                <>
                  <Check size={16} />
                  Preview saved
                </>
              ) : (
                <>
                  Continue
                  <ChevronDown size={15} />
                </>
              )}
            </button>
          </div>
        </form>

        <aside className="offer-preview" aria-label="Offer preview">
          <div className="preview-label">
            <span>
              <Eye size={13} />
              Preview
            </span>
            <b>BUYER VIEW</b>
          </div>

          <div className="preview-card liquid-surface">
            <div className="preview-art" aria-hidden="true">
              <span className="preview-orb orb-one" />
              <span className="preview-orb orb-two" />
              <span className="preview-orb orb-three" />
              <i>{category.slice(0, 1)}</i>
            </div>

            <div className="preview-copy">
              <span>{category || "Category"}</span>
              <h2>{title || "Untitled offer"}</h2>
              <p>{description || "Add a short description to your offer."}</p>

              <div className="preview-meta">
                <div>
                  <MapPin size={12} />
                  {location || "Location"}
                </div>
                <div>
                  <Package size={12} />
                  {availability || "0"} available
                </div>
                <div title="Seller-chosen access policy, pinned on-chain with the listing">
                  {humanPolicy === "one-per-human" ? "1/HUMAN · World ID" : "open bidding"}
                </div>
              </div>

              <div className="preview-price">
                <span>Auction starts at</span>
                <strong>€{price || "—"}</strong>
              </div>
            </div>
          </div>

          <p className="preview-note">
            This is a visual preview. Publishing logic will be connected later.
          </p>
        </aside>
      </div>
    </section>
  );
}
