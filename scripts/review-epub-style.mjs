#!/usr/bin/env node
// Compare actual packaged rendering with captured author-source print styles.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [inputDir, reviewDir, chromiumPath, ...selected] = process.argv.slice(2);
if (!inputDir || !reviewDir)
  throw new Error(
    "Usage: review-epub-style.mjs EPUB_DIR REVIEW_DIR [CHROMIUM] [KEY ...]",
  );
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rust-epub-style-"));
const books = selected.length
  ? selected
  : fs
      .readdirSync(inputDir)
      .filter((key) => fs.existsSync(path.join(inputDir, key, `${key}.epub`)));
fs.mkdirSync(reviewDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
});
let failures = 0;
try {
  for (const [key, format] of books.flatMap((key) => [
    [key, "epub"],
    [key, "azw3"],
  ])) {
    const folder = path.join(temp, `${key}-${format}`);
    fs.mkdirSync(folder);
    if (format === "epub")
      execFileSync("unzip", [
        "-qq",
        path.join(inputDir, key, `${key}.epub`),
        "-d",
        folder,
      ]);
    else
      execFileSync(
        "calibre-debug",
        ["--explode-book", path.join(inputDir, key, `${key}.azw3`), folder],
        {
          env: {
            ...process.env,
            CALIBRE_CONFIG_DIRECTORY: path.join(temp, "converter-config"),
          },
        },
      );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(inputDir, key, "manifest.json"), "utf8"),
    );
    const samples = manifest.presentation?.samples;
    if (!samples?.length)
      throw new Error(`${key}: no author-source presentation reference`);
    const files = fs
      .readdirSync(folder, { recursive: true })
      .filter((name) => /\.(?:x?html)$/.test(name));
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
    });
    await page.route(/^https?:/, (route) => route.abort());
    let screenshot = false;
    try {
      for (const sample of samples) {
        const id = sample.selector.slice(1).replace(/\\/g, "");
        const file = files.find((name) =>
          fs
            .readFileSync(path.join(folder, name), "utf8")
            .includes(`id="${id}"`),
        );
        if (!file)
          throw new Error(
            `${key}: source style sample ${sample.selector} disappeared`,
          );
        await page.goto(pathToFileURL(path.join(folder, file)).href);
        await page.evaluate(() => document.fonts.ready);
        const actual = await page.evaluate(
          ({ selector, properties }) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`Missing ${selector}`);
            const style = getComputedStyle(element);
            return Object.fromEntries(
              properties.map((name) => [name, style.getPropertyValue(name)]),
            );
          },
          { selector: sample.selector, properties: Object.keys(sample.styles) },
        );
        for (const [property, expected] of Object.entries(sample.styles)) {
          const value = actual[property];
          const numeric =
            /^(?:font-size|line-height|padding-left|text-indent|border-left-width)$/.test(
              property,
            );
          const equal =
            value === expected ||
            (numeric &&
              expected.endsWith("px") &&
              value.endsWith("px") &&
              Math.abs(parseFloat(value) - parseFloat(expected)) < 0.6);
          if (!equal) {
            failures++;
            console.error(
              `${key} ${sample.selector} ${property}: source=${expected} ${format}=${value}`,
            );
          }
        }
        if (!screenshot && (await page.locator("pre").count())) {
          await page.locator("pre").first().scrollIntoViewIfNeeded();
          await page.screenshot({
            path: path.join(reviewDir, `${key}-${format}-code.png`),
          });
          screenshot = true;
        }
      }
      console.log(
        `${key} ${format}: compared ${samples.length} author-source presentation samples`,
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  fs.rmSync(temp, { recursive: true });
}
if (failures) process.exitCode = 1;
