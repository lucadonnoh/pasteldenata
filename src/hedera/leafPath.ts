import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the leaf agent script for child_process.fork. Always resolved from
 * the project root: an import.meta.url-relative path breaks under Next.js,
 * where Turbopack rewrites `new URL("./leafAgent.ts", import.meta.url)` into
 * an isolated build asset that cannot resolve its sibling imports.
 */
export function leafAgentPath(): string {
  const fromRoot = join(process.cwd(), "src", "hedera", "leafAgent.ts");
  if (!existsSync(fromRoot)) {
    throw new Error(
      `Leaf agent not found at ${fromRoot}. Run from the project root.`,
    );
  }
  return fromRoot;
}
