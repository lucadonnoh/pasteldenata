/**
 * RFC 8785 JSON Canonicalization Scheme for JSON-compatible values.
 *
 * JSON.stringify supplies the ECMAScript string and number serialization JCS
 * requires; object member names are ordered by their UTF-16 code units.
 */
export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error("Cannot canonicalize an unsupported JSON value.");
    }
    return encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }

  throw new Error("Cannot canonicalize an unsupported JSON value.");
}
