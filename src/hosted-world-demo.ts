export type HostedWorldDemoChoice = "verified" | "visitor";

const SESSION_KEY = "pastel-hosted-world-session-v1";
const CHOICE_KEY = "pastel-hosted-world-choice-v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hostedWorldSessionId(): string {
  const existing = window.localStorage.getItem(SESSION_KEY);
  if (existing && UUID_V4.test(existing)) return existing;
  const created = window.crypto.randomUUID();
  window.localStorage.setItem(SESSION_KEY, created);
  return created;
}

export function freshHostedWorldSessionId(): string {
  const created = window.crypto.randomUUID();
  window.localStorage.setItem(SESSION_KEY, created);
  return created;
}

export function hostedWorldDemoChoice(): HostedWorldDemoChoice {
  return window.localStorage.getItem(CHOICE_KEY) === "visitor"
    ? "visitor"
    : "verified";
}

export function saveHostedWorldDemoChoice(
  choice: HostedWorldDemoChoice,
): void {
  window.localStorage.setItem(CHOICE_KEY, choice);
}

export function hostedWorldReadinessUrl(sessionId: string): string {
  const params = new URLSearchParams({ worldSession: sessionId });
  return `/api/readiness?${params}`;
}
