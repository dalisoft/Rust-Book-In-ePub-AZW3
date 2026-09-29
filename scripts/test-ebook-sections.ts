import assert from "node:assert/strict";
import { chromium } from "playwright";
import { sectionBook } from "../src/shared/ebook-sections.ts";

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {},
);
try {
  const page = await browser.newPage();
  const html = Array.from(
    { length: 40 },
    (_, index) =>
      `<h1 id="chapter-${index}">Chapter ${index}</h1><p>${"Rust &amp; code ".repeat(3000)}</p><pre><code>fn main() {}</code></pre><table><tr><td>whole table</td></tr></table><img src="assets/example.png"><a href="#chapter-${(index + 1) % 40}">Next</a>`,
  ).join("");
  const parts = await page.evaluate(sectionBook, html);
  assert.ok(parts.length > 1);
  const result = await page.evaluate(
    ({ html, parts }) => {
      const parse = (value: string) =>
        new DOMParser().parseFromString(value, "text/html");
      const original = parse(html);
      const split = parts.map((part) => parse(part.html));
      const count = (selector: string) =>
        split.reduce(
          (total, part) => total + part.querySelectorAll(selector).length,
          0,
        );
      const targets = new Map(
        parts.map((part, index) => [part.name, split[index]]),
      );
      return {
        textPreserved:
          original.body.textContent ===
          split.map((part) => part.body.textContent).join(""),
        elementsPreserved: ["h1", "pre", "code", "table", "img", "[id]"].every(
          (selector) =>
            count(selector) === original.querySelectorAll(selector).length,
        ),
        linksValid: split.every((part) =>
          [...part.querySelectorAll("a")].every((link) => {
            const [file, id] = link.getAttribute("href")!.split("#");
            return Boolean(targets.get(file)?.getElementById(id));
          }),
        ),
      };
    },
    { html, parts },
  );
  assert.deepEqual(result, {
    textPreserved: true,
    elementsPreserved: true,
    linksValid: true,
  });
  const small = await page.evaluate(
    sectionBook,
    '<h1 id="unicode-é">Small</h1><a href="#unicode-%C3%A9">Unicode</a>',
  );
  assert.equal(small.length, 1);
  assert.match(small[0].html, /part-0000.html#unicode-%C3%A9/);
  await assert.rejects(
    page.evaluate(sectionBook, '<p><a href="#absent">Broken</a></p>'),
    /Unresolved section anchor/,
  );
  console.log(
    "Sectioning verified: complete content, intact blocks, cross-flow and Unicode links",
  );
} finally {
  await browser.close();
}
