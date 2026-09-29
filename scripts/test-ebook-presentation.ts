import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { capturePresentation } from "../src/shared/ebook-presentation.ts";

const stage = fs.mkdtempSync(
  path.join(os.tmpdir(), "ebook-presentation-test-"),
);
fs.mkdirSync(path.join(stage, "assets"));
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {},
);
try {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.setContent(`<html class="light"><head><style>
    :root {--ink:rgb(23,45,67);--paper:rgb(240,241,242)}
    main {font-family:serif;color:var(--ink, rgb(0,0,0))}
    p {line-height:1.4;text-indent:2em}
    pre {white-space:pre;background:var(--absent,var(--paper,rgb(1,2,3)))}
    h1 {font-size:2em}
    @media print {h2 {break-before:page}}
    @media screen {h2 {color:red}}
  </style></head><body><style>h1 {font-size:3em}</style><div class="author-content"><main>
    <h1>Title</h1><p>Author paragraph.</p><h2>Chapter</h2>
    <pre><code>fn main() {\n    let value = 42;\n}</code></pre>
    <svg xmlns="http://www.w3.org/2000/svg"><style>.diagram {stroke:black}</style><path class="diagram" d="M0,0 L10,10"/></svg>
  </main></div></body></html>`);
  const presentation = await capturePresentation(page, stage, async (url) => {
    throw new Error(`Unexpected remote request: ${url}`);
  });
  assert.ok(!presentation.css.includes("var("));
  assert.equal(
    await page.locator("path").getAttribute("stroke"),
    "rgb(0, 0, 0)",
  );
  assert.ok(presentation.css.replaceAll(" ", "").includes("rgb(23,45,67)"));
  assert.ok(presentation.css.replaceAll(" ", "").includes("rgb(240,241,242)"));
  assert.ok(!presentation.css.includes("color:red"));
  assert.ok(
    presentation.css.includes("font-size:3em"),
    "styles inside author chapters must survive",
  );
  assert.equal(presentation.wrappers[0].attributes, 'class="author-content"');
  assert.equal(
    await page
      .locator("h2")
      .evaluate((e) =>
        (e as HTMLElement).style.getPropertyValue("page-break-before"),
      ),
    "always",
  );
  assert.ok(
    (await page.locator("code").textContent())?.includes("\n    let value"),
  );
  assert.ok(
    presentation.samples.every((sample) => sample.selector.startsWith("#")),
  );
  console.log(
    "Author presentation: print cascade, nested variables, breaks, wrappers and code indentation verified",
  );
} finally {
  await browser.close();
  fs.rmSync(stage, { recursive: true });
}
