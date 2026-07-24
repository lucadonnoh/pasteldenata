export function tomorrowInLisbon(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);

  const tomorrow = new Date(
    Date.UTC(read("year"), read("month") - 1, read("day") + 1),
  );
  return tomorrow.toISOString().slice(0, 10);
}
