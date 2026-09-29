#!/usr/bin/env node
// Render packaged EPUB pages with their packaged CSS for visual regression review.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [inputDir, reviewDir, chromiumPath] = process.argv.slice(2);
if (!inputDir || !reviewDir) {
  throw new Error(
    "Usage: node scripts/review-epub-style.mjs EPUB_DIR REVIEW_DIR [CHROMIUM]",
  );
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rust-epub-style-"));
const books = fs
  .readdirSync(inputDir)
  .filter((key) => fs.existsSync(path.join(inputDir, key, `${key}.epub`)));
fs.mkdirSync(reviewDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
});
let failures = 0;
try {
  for (const key of books) {
    const folder = path.join(temp, key);
    fs.mkdirSync(folder);
    execFileSync("unzip", [
      "-qq",
      path.join(inputDir, key, `${key}.epub`),
      "-d",
      folder,
    ]);
    const pages = fs
      .readdirSync(folder)
      .filter(
        (name) =>
          name === "book.html" ||
          /^(?:book_split_.*|part-\d+(?:_split_\d+)?)\.html$/.test(name),
      )
      .sort();
    const sample =
      pages.find((name) =>
        /<pre\b/.test(fs.readFileSync(path.join(folder, name), "utf8")),
      ) ?? pages[0];
    if (!sample) throw new Error(`${key}: no content page`);
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
      deviceScaleFactor: 1,
    });
    try {
      await page.goto(pathToFileURL(path.join(folder, sample)).href);
      const code = page.locator("pre").first();
      if (await code.count()) await code.scrollIntoViewIfNeeded();
      const styles = await page.evaluate(() => {
        const body = getComputedStyle(document.body);
        const code = document.querySelector("pre");
        const codeStyle = code ? getComputedStyle(code) : null;
        return {
          font: body.fontFamily,
          lineHeight: body.lineHeight,
          codeBackground: codeStyle?.backgroundColor ?? null,
          codeBorder: codeStyle?.borderLeftWidth ?? null,
        };
      });
      if (
        !styles.font.toLowerCase().includes("georgia") ||
        (styles.codeBackground &&
          styles.codeBackground !== "rgb(241, 244, 246)")
      ) {
        failures++;
        console.error(
          `${key}: unexpected rendered styles ${JSON.stringify(styles)}`,
        );
      } else {
        console.log(`${key}: ${sample} ${JSON.stringify(styles)}`);
      }
      await page.screenshot({ path: path.join(reviewDir, `${key}.png`) });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  fs.rmSync(temp, { recursive: true });
}
if (failures) process.exitCode = 1;
