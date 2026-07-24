export function parseBudgetCents(intent: string): number {
  const dollarMatch = intent.match(/\$\s*([\d,.]+)/i);
  const wordMatch = intent.match(/([\d,.]+)\s*(?:usd|dollars?)/i);
  const raw = dollarMatch?.[1] ?? wordMatch?.[1];

  if (!raw) {
    throw new Error(
      'The intent must contain a USD budget, for example "my budget is $200".',
    );
  }

  const amount = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("The budget must be a positive USD amount.");
  }

  return Math.round(amount * 100);
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function neuronToOg(neuron?: string): string | undefined {
  if (!neuron || !/^\d+$/.test(neuron)) return undefined;
  const value = BigInt(neuron);
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
