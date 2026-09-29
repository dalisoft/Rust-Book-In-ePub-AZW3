import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { getProjectRoot, loadConfig } from "../src/shared/config.ts";
import type { BuildPlan } from "./ebook-cache.ts";

const root = getProjectRoot(import.meta.url);
const config = loadConfig(import.meta.url);
const bookArgs = process.argv
  .slice(2)
  .filter((arg) => arg.startsWith("--book="));
const outputArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--output-dir="));
const planArg = process.argv.slice(2).find((arg) => arg.startsWith("--plan="));
if (
  process.argv
    .slice(2)
    .some((arg) => !/^--(book|output-dir|plan)=/.test(arg)) ||
  !outputArg
) {
  throw new Error(
    "Usage: node scripts/build-ebooks-workers.ts --output-dir=PATH [--book=KEY ... | --plan=PATH]",
  );
}
if (process.env.CALIBRE_LIBRARY || process.env.METADATA_MAP) {
  throw new Error("The CI worker build must not access a Calibre library");
}
const outputDir = path.resolve(outputArg.slice("--output-dir=".length));
const plan =
  planArg &&
  (JSON.parse(
    fs.readFileSync(path.resolve(planArg.slice(7)), "utf8"),
  ) as BuildPlan);
if (plan && (plan.version !== 1 || bookArgs.length))
  throw new Error("Invalid or conflicting build plan");
const keys = plan
  ? plan.buildKeys
  : bookArgs.length
    ? bookArgs.map((arg) => arg.slice("--book=".length))
    : Object.keys(config.Books);
if (
  new Set(keys).size !== keys.length ||
  keys.some((key) => !/^[A-Za-z0-9_-]+$/.test(key) || !config.Books[key])
) {
  throw new Error("Unknown, unsafe, or duplicate book key");
}
if (keys.length === 0) {
  console.log("No books need conversion; using verified cached formats");
  process.exit(0);
}
const requestedWorkers = Number(process.env.BOOK_BUILD_WORKERS ?? "4");
if (
  !Number.isInteger(requestedWorkers) ||
  requestedWorkers < 1 ||
  requestedWorkers > 4
) {
  throw new Error("BOOK_BUILD_WORKERS must be an integer from 1 to 4");
}
const groups = Array.from(
  { length: Math.min(requestedWorkers, keys.length) },
  (): string[] => [],
);
const remaining = [...keys];
if (groups.length > 1 && remaining.includes("RustRFCs")) {
  // The RFC book took about four minutes in the serial CI build. Start it
  // immediately and overlap it with all other books.
  groups[0].push("RustRFCs");
  remaining.splice(remaining.indexOf("RustRFCs"), 1);
  remaining.forEach((key, index) =>
    groups[1 + (index % (groups.length - 1))].push(key),
  );
} else {
  remaining.forEach((key, index) => groups[index % groups.length].push(key));
}

async function runWorker(index: number, books: string[]): Promise<number> {
  const configDir = path.join(
    root,
    ".cache",
    "calibre-config",
    `worker-${index + 1}`,
  );
  fs.mkdirSync(configDir, { recursive: true });
  console.log(`Worker ${index + 1}: ${books.join(", ")}`);
  const args = [
    path.join(root, "src", "generate-ebooks.ts"),
    ...books.map((key) => `--book=${key}`),
    `--output-dir=${outputDir}`,
  ];
  if (process.env.CHROMIUM_PATH)
    args.push(`--chromium=${process.env.CHROMIUM_PATH}`);
  if (plan) args.push(`--source-dir=${plan.sourceDir}`);
  return await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, CALIBRE_CONFIG_DIRECTORY: configDir },
      stdio: "inherit",
    });
    child.once("error", (error) => {
      console.error(`Worker ${index + 1}: ${error}`);
      resolve(1);
    });
    child.once("close", (code, signal) => {
      if (code !== 0)
        console.error(`Worker ${index + 1}: exit ${code ?? signal}`);
      resolve(code ?? 1);
    });
  });
}

const results = await Promise.all(
  groups.map((books, index) => runWorker(index, books)),
);
if (results.some((code) => code !== 0)) {
  throw new Error("One or more ebook workers failed");
}
