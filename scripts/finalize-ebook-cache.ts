import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "../src/shared/config.ts";
import { artifactHash, validArtifact, type BuildPlan } from "./ebook-cache.ts";
import type { ImageSource } from "../src/shared/ebook-sources.ts";

const options = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--(plan|output|output-dir|files)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    return [match[1], path.resolve(match[2])];
  }),
);
for (const option of ["plan", "output", "output-dir", "files"])
  if (!options.has(option)) throw new Error(`Missing --${option}=PATH`);
const plan = JSON.parse(
  fs.readFileSync(options.get("plan")!, "utf8"),
) as BuildPlan;
const keys = Object.keys(loadConfig(import.meta.url).Books).sort();
if (
  plan.version !== 1 ||
  keys.join() !== Object.keys(plan.snapshot.sources).sort().join() ||
  [...plan.buildKeys, ...plan.reusedKeys].sort().join() !== keys.join()
)
  throw new Error("Build plan does not cover exactly the configured books");
const files: string[] = [];
const tag =
  process.env.BOOK_RELEASE_TAG ??
  `release-${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Samarkand" }).format(new Date())}`;
if (!/^release-\d{4}-\d{2}-\d{2}$/.test(tag))
  throw new Error("Invalid daily release tag");
for (const key of keys) {
  const source = plan.snapshot.sources[key];
  const folder = path.join(options.get("output-dir")!, key);
  if (plan.buildKeys.includes(key)) {
    const generated = JSON.parse(
      fs.readFileSync(path.join(folder, "manifest.json"), "utf8"),
    ) as {
      sourceSha256: string;
      sourceImages: Record<string, ImageSource>;
      sourceStyles: Record<string, ImageSource>;
    };
    if (generated.sourceSha256 !== source.sha256 || !generated.sourceImages)
      throw new Error(`Generated source differs from fingerprint: ${key}`);
    source.images = generated.sourceImages;
    if (!generated.sourceStyles || !Object.keys(generated.sourceStyles).length)
      throw new Error(`Missing authored presentation fingerprints: ${key}`);
    source.styles = generated.sourceStyles;
    source.artifacts = {
      epub: artifactHash(path.join(folder, `${key}.epub`)),
      azw3: artifactHash(path.join(folder, `${key}.azw3`)),
    };
    source.artifactRelease = tag;
  }
  for (const format of ["epub", "azw3"] as const) {
    if (!source.artifacts || !source.artifactRelease)
      throw new Error(`Missing verified artifact location: ${key}`);
    // Unchanged formats stay in the verified earlier release; no local copy
    // or re-upload is needed. Only generated files enter the upload list.
    if (!plan.buildKeys.includes(key)) continue;
    const file = path.join(folder, `${key}.${format}`);
    if (!source.artifacts || !validArtifact(file, source.artifacts[format]))
      throw new Error(`Missing or changed verified artifact: ${key}.${format}`);
    files.push(file);
  }
}
// Include earlier updates on the same day when verifying an existing tag.
plan.snapshot.publishedKeys = keys.filter(
  (key) => plan.snapshot.sources[key].artifactRelease === tag,
);
for (const [option, text] of [
  ["output", `${JSON.stringify(plan.snapshot, null, 2)}\n`],
  ["files", `${files.join("\n")}\n`],
] as const) {
  fs.mkdirSync(path.dirname(options.get(option)!), { recursive: true });
  fs.writeFileSync(options.get(option)!, text);
}
console.log(
  `Cache finalized: ${plan.buildKeys.length} built, ${plan.reusedKeys.length} reused`,
);
