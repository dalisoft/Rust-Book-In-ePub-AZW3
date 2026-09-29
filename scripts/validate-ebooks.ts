import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pLimit from "p-limit";
import { getProjectRoot } from "../src/shared/config.ts";
import type { BuildPlan } from "./ebook-cache.ts";

const run = promisify(execFile);
const root = getProjectRoot(import.meta.url);
const options = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--(output-dir|plan)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    return [match[1], path.resolve(match[2])];
  }),
);
const outputDir = options.get("output-dir");
if (!outputDir) throw new Error("Missing --output-dir=PATH");
const plan = options.has("plan")
  ? (JSON.parse(fs.readFileSync(options.get("plan")!, "utf8")) as BuildPlan)
  : undefined;
if (plan && plan.version !== 1) throw new Error("Invalid build plan");
const keys =
  plan?.buildKeys ??
  fs
    .readdirSync(outputDir)
    .filter((key) => fs.existsSync(path.join(outputDir, key, `${key}.epub`)));
if (!keys.length && !plan) throw new Error("No ebooks found to validate");
const limit = pLimit(4);
await Promise.all(
  keys.map((key) =>
    limit(async () => {
      if (!/^[A-Za-z0-9_-]+$/.test(key))
        throw new Error(`Unsafe book key: ${key}`);
      const epub = path.join(outputDir, key, `${key}.epub`);
      const azw3 = path.join(outputDir, key, `${key}.azw3`);
      const configDir = path.join(
        root,
        ".cache",
        "calibre-config",
        `validate-${key}`,
      );
      fs.mkdirSync(configDir, { recursive: true });
      if (fs.statSync(azw3).size < 1024)
        throw new Error(`Missing/empty AZW3: ${key}`);
      const commands: Array<[string, string[]]> = [
        ["unzip", ["-tq", epub]],
        ["python3", [path.join(root, "scripts/check-epub-links.py"), epub]],
        ["python3", [path.join(root, "scripts/check-epub-style.py"), epub]],
        ["python3", [path.join(root, "scripts/check-epub-content.py"), epub]],
        ...(key === "EasyRust"
          ? ([
              [
                "python3",
                [path.join(root, "scripts/check-easy-rust-style.py"), epub],
              ],
            ] as Array<[string, string[]]>)
          : []),
        ["ebook-meta", [epub]],
        ["ebook-meta", [azw3]],
      ];
      for (const [command, args] of commands) {
        try {
          const result = await run(command, args, {
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, CALIBRE_CONFIG_DIRECTORY: configDir },
          });
          if (command === "python3") console.log(result.stdout.trim());
        } catch (error) {
          throw new Error(`${key}: ${command} validation failed: ${error}`);
        }
      }
      console.log(`${key}: EPUB/AZW3 validated`);
    }),
  ),
);
console.log(
  `Validated ${keys.length} rebuilt books; ${plan?.reusedKeys.length ?? 0} cached books retain matching validation recipe and SHA-256`,
);
