import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import pLimit from "p-limit";
import { loadConfig } from "../src/shared/config.ts";
import { normalizeHttpUrl } from "../src/shared/url.ts";

type Source = { url: string; sha256: string };
type Snapshot = { version: 1; sources: Record<string, Source> };

const config = loadConfig(import.meta.url);
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline="));
if (
  !outputArg ||
  process.argv.slice(2).some((arg) => !/^--(output|baseline)=/.test(arg))
) {
  throw new Error(
    "Usage: node scripts/check-source-updates.ts --output=PATH [--baseline=PATH]",
  );
}
const output = path.resolve(outputArg.slice("--output=".length));
const baselinePath =
  baselineArg && path.resolve(baselineArg.slice("--baseline=".length));

async function fingerprint(url: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(90_000),
        headers: { "User-Agent": "Rust-Book-In-ePub-AZW3 source check" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length < 1000 || !/<main(?:\s|>)/i.test(body.toString("utf8"))) {
        throw new Error(
          "Response does not contain a print-book <main> element",
        );
      }
      return createHash("sha256").update(body).digest("hex");
    } catch (error) {
      if (attempt === 2) throw new Error(`${url}: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`${url}: retries exhausted`);
}

const limit = pLimit(4);
const entries = await Promise.all(
  Object.entries(config.Books)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, book]) =>
      limit(async (): Promise<[string, Source]> => {
        const url = normalizeHttpUrl(book.print_url);
        return [key, { url, sha256: await fingerprint(url) }];
      }),
    ),
);
const snapshot: Snapshot = { version: 1, sources: Object.fromEntries(entries) };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);

let changed = true;
if (baselinePath) {
  const baseline = JSON.parse(
    fs.readFileSync(baselinePath, "utf8"),
  ) as Snapshot;
  if (
    baseline.version !== 1 ||
    !baseline.sources ||
    typeof baseline.sources !== "object"
  ) {
    throw new Error("Unsupported source fingerprint baseline");
  }
  const keys = new Set([
    ...Object.keys(baseline.sources),
    ...Object.keys(snapshot.sources),
  ]);
  const updated = [...keys].filter(
    (key) =>
      baseline.sources[key]?.url !== snapshot.sources[key]?.url ||
      baseline.sources[key]?.sha256 !== snapshot.sources[key]?.sha256,
  );
  changed = updated.length > 0;
  console.error(
    updated.length
      ? `Changed sources: ${updated.join(", ")}`
      : "Official print pages unchanged",
  );
}
console.log(`changed=${changed}`);
