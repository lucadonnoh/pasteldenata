import type { City } from "./domain";

export const CITY_TIME_ZONES: Record<City, string> = {
  lisbon: "Europe/Lisbon",
  milan: "Europe/Rome",
  tokyo: "Asia/Tokyo",
  mumbai: "Asia/Kolkata",
  newyork: "America/New_York",
};

export function tomorrowInTimeZone(
  timeZone: string,
  now = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
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

export function tomorrowInCity(city: City, now = new Date()): string {
  return tomorrowInTimeZone(CITY_TIME_ZONES[city], now);
}

export function tomorrowInLisbon(now = new Date()): string {
  return tomorrowInCity("lisbon", now);
}
