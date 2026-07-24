"use client";

import { ArrowUp, ShieldCheck, Sparkles } from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  useState,
} from "react";

const examples = [
  "Organize me a date tomorrow in Lisbon. My budget is $200.",
  "Plan a memorable birthday in Lisbon. My budget is $150.",
  "Arrange a romantic evening tomorrow. I can spend $180.",
];

export function IntentBox() {
  const [intent, setIntent] = useState(examples[0] ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (intent.trim().length < 3 || loading) return;

    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent }),
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "The agent could not answer.");
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Something went wrong.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function moveGlassHighlight(event: PointerEvent<HTMLFormElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    event.currentTarget.style.setProperty("--glass-x", `${x}%`);
    event.currentTarget.style.setProperty("--glass-y", `${y}%`);
  }

  return (
    <section className="workspace" aria-label="Private intent planner">
      <form
        className="composer"
        onSubmit={submit}
        onPointerMove={moveGlassHighlight}
        onPointerLeave={(event) => {
          event.currentTarget.style.setProperty("--glass-x", "50%");
          event.currentTarget.style.setProperty("--glass-y", "0%");
        }}
      >
        <div className="composer-chrome">
          <span>What do you need?</span>
          <span>Private session</span>
        </div>

        <div className="composer-input">
          <textarea
            aria-label="Describe what you need"
            value={intent}
            maxLength={1200}
            onChange={(event) => setIntent(event.target.value)}
            onKeyDown={handleShortcut}
            placeholder="Tell the market what you need…"
            rows={3}
          />
          <button
            className="launch-button"
            type="submit"
            disabled={loading || intent.trim().length < 3}
            aria-label="Send intent"
          >
            {loading ? <span className="spinner" /> : <ArrowUp size={22} />}
          </button>
        </div>

        <div className="composer-footer">
          <div className="privacy-note">
            <ShieldCheck size={13} />
            Private inference
          </div>
          <div className="character-count">
            <span>⌘ ENTER</span>
            <b>{intent.length.toString().padStart(4, "0")}</b>
          </div>
        </div>
      </form>

      {!loading && !error && (
        <div className="suggestions">
          <span>Examples</span>
          <div>
            {examples.slice(1).map((example) => (
              <button
                type="button"
                key={example}
                onClick={() => setIntent(example)}
              >
                <span>{example}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div className="thinking" aria-live="polite">
          <div className="thinking-visual">
            <div className="thinking-ring" />
            <Sparkles size={18} />
          </div>
          <div className="thinking-copy">
            <span>0G PRIVATE COMPUTE</span>
            <strong>Turning your intent into market mandates</strong>
            <p>Extracting constraints · Allocating budget · Sealing context</p>
          </div>
        </div>
      )}

      {error && (
        <div className="error-message" role="alert">
          <strong>We couldn&apos;t process this intent.</strong>
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
