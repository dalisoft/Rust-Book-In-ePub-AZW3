import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pLimit from "p-limit";
import { getProjectRoot, loadConfig } from "../src/shared/config.ts";
import { normalizeHttpUrl } from "../src/shared/url.ts";
import {
  prepareBuildPlan,
  readSnapshot,
  recipeHash,
  scanBook,
  validArtifact,
  type Release,
  type Snapshot,
} from "./ebook-cache.ts";

const run = promisify(execFile);
const root = getProjectRoot(import.meta.url);
const config = loadConfig(import.meta.url);
const options = new Map(
  process.argv.slice(2).map((arg) => {
    const match =
      /^--(output|baseline|plan|source-dir|output-dir|release)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    return [match[1], path.resolve(match[2])];
  }),
);
for (const option of ["output", "plan", "source-dir", "output-dir"])
  if (!options.has(option)) throw new Error(`Missing --${option}=PATH`);
const baseline = options.has("baseline")
  ? readSnapshot(options.get("baseline")!)
  : undefined;
const release = options.has("release")
  ? (JSON.parse(fs.readFileSync(options.get("release")!, "utf8")) as Release)
  : undefined;
const sourceDir = options.get("source-dir")!;
const limit = pLimit(4);
const imageLimit = pLimit(8);
const entries = await Promise.all(
  Object.entries(config.Books)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, book]) =>
      limit(
        async () =>
          [
            key,
            await scanBook(
              key,
              book,
              normalizeHttpUrl(book.print_url),
              recipeHash(root, book),
              baseline?.sources[key],
              sourceDir,
              imageLimit,
            ),
          ] as const,
      ),
    ),
);
const snapshot: Snapshot = { version: 2, sources: Object.fromEntries(entries) };
const plan = await prepareBuildPlan(
  snapshot,
  baseline,
  sourceDir,
  options.get("output-dir")!,
  release,
  async (key, folder) => {
    if (!release) throw new Error("No release available for artifact restore");
    const temp = fs.mkdtempSync(path.join(sourceDir, "restore-"));
    try {
      await run(
        "gh",
        [
          "release",
          "download",
          release.tag_name,
          "--pattern",
          `${key}.epub`,
          "--pattern",
          `${key}.azw3`,
          "--dir",
          temp,
        ],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      );
      for (const format of ["epub", "azw3"] as const)
        if (
          !validArtifact(
            path.join(temp, `${key}.${format}`),
            baseline!.sources[key].artifacts![format],
          )
        )
          throw new Error(`Corrupt release asset: ${key}.${format}`);
      fs.mkdirSync(folder, { recursive: true });
      for (const format of ["epub", "azw3"])
        fs.copyFileSync(
          path.join(temp, `${key}.${format}`),
          path.join(folder, `${key}.${format}`),
        );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);
for (const [option, value] of [
  ["output", snapshot],
  ["plan", plan],
] as const) {
  const file = options.get(option)!;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
console.error(
  `Books to build: ${plan.buildKeys.length} (${plan.buildKeys.join(", ") || "none"}); reused: ${plan.reusedKeys.length}; removed: ${plan.removedKeys.length}`,
);
console.log(`changed=${!!(plan.buildKeys.length || plan.removedKeys.length)}`);
console.log(`build_required=${plan.buildKeys.length > 0}`);
