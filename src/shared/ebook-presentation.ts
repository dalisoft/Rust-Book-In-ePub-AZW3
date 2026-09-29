import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { sha256, type ImageDownload } from "./ebook-sources.ts";

export type Presentation = {
  css: string;
  htmlAttributes: string;
  bodyAttributes: string;
  wrappers: Array<{ tag: string; attributes: string }>;
  assets: Array<{ file: string; mime: string }>;
  samples: Array<{ selector: string; styles: Record<string, string> }>;
};

// Runs in Chromium: resolve the author's selected print/light cascade, not a
// replacement theme. Reader-incompatible CSS variables become literal values.
function resolvePresentationCss(css: string): string {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const main = document.querySelector("main")!;
  const resolve = (value: string, element: Element): string => {
    for (let pass = 0; pass < 100 && value.includes("var("); pass++) {
      const start = value.indexOf("var(");
      let depth = 1,
        end = start + 4,
        comma = -1;
      for (; end < value.length && depth; end++) {
        if (value[end] === "(") depth++;
        else if (value[end] === ")") depth--;
        else if (value[end] === "," && depth === 1 && comma < 0) comma = end;
      }
      if (depth) throw new Error(`Unresolved source CSS variable: ${value}`);
      const name = value.slice(start + 4, comma < 0 ? end - 1 : comma).trim();
      const fallback = comma < 0 ? "" : value.slice(comma + 1, end - 1).trim();
      const replacement =
        getComputedStyle(element).getPropertyValue(name).trim() || fallback;
      value = value.slice(0, start) + replacement + value.slice(end);
    }
    if (value.includes("var("))
      throw new Error(`Cyclic source CSS variable: ${value}`);
    return value;
  };
  const rules = (list: CSSRuleList): string =>
    Array.from(list)
      .map((rule) => {
        if (rule instanceof CSSMediaRule)
          return matchMedia(rule.conditionText).matches
            ? rules(rule.cssRules)
            : "";
        if (rule instanceof CSSSupportsRule)
          return CSS.supports(rule.conditionText) ? rules(rule.cssRules) : "";
        if (rule instanceof CSSStyleRule) {
          let element: Element | null = null;
          try {
            element = document.querySelector(rule.selectorText);
          } catch {
            /* pseudo selector */
          }
          // Resolve before expansion: unresolved shorthand properties expose
          // empty longhands through CSSOM (e.g. background:var(--paper)).
          const style = document.createElement("div").style;
          style.cssText = resolve(rule.style.cssText, element ?? main);
          const declarations = Array.from(style)
            .filter((name) => !name.startsWith("--"))
            .map(
              (name) =>
                `${name}:${style.getPropertyValue(name)}${style.getPropertyPriority(name) ? " !important" : ""};`,
            )
            .join("");
          const whiteSpace = style.getPropertyValue("white-space");
          return declarations
            ? `${rule.selectorText}{${declarations}${whiteSpace ? `white-space:${whiteSpace};` : ""}}`
            : "";
        }
        if (rule instanceof CSSFontFaceRule) return rule.cssText;
        // Keyframes/animation and @page sizes belong to the web/print UI, not
        // reflowable reader chrome. Content break declarations above are retained.
        return "";
      })
      .join("\n");
  return rules(sheet.cssRules);
}

export async function capturePresentation(
  page: Page,
  stage: string,
  resource: (url: string) => Promise<ImageDownload>,
): Promise<Presentation> {
  await page.emulateMedia({ media: "print", colorScheme: "light" });
  await page.evaluate(() => {
    document.documentElement.classList.remove(
      "dark",
      "coal",
      "navy",
      "ayu",
      "rust",
    );
    document.documentElement.classList.add("light");
  });
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('link[rel~="stylesheet"],style'))
      .filter(
        (node) =>
          node instanceof HTMLLinkElement || node instanceof HTMLStyleElement,
      )
      .map((node) => ({
        url: node instanceof HTMLLinkElement ? node.href : location.href,
        css:
          node instanceof HTMLStyleElement
            ? (node.textContent ?? "")
            : undefined,
        media: node.getAttribute("media") || "all",
      })),
  );
  const load = async (
    url: string,
    inline?: string,
    ancestors = new Set<string>(),
  ): Promise<string> => {
    if (ancestors.has(url) && inline === undefined)
      throw new Error(`Cyclic CSS import: ${url}`);
    const css = inline ?? (await resource(url)).bytes!.toString("utf8");
    const stack = new Set(ancestors).add(url);
    const imports = Array.from(
      css.matchAll(
        /@import\s+(?:url\(\s*['"]?([^'"\s)]+)['"]?\s*\)|['"]([^'"]+)['"])\s*([^;]*);/gi,
      ),
    );
    let result = css;
    for (const match of imports) {
      const imported = await load(
        new URL(match[1] ?? match[2], url).href,
        undefined,
        stack,
      );
      result = result.replace(
        match[0],
        match[3].trim() ? `@media ${match[3]}{${imported}}` : imported,
      );
    }
    // Resolve relative URLs before joining sheets from different directories.
    return result.replace(
      /url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/gi,
      (raw, _quote, ref) =>
        /^(?:data:|#)/.test(ref) ? raw : `url("${new URL(ref, url).href}")`,
    );
  };
  let css = (
    await Promise.all(
      links
        .filter(
          (link) =>
            !/\/(?:tomorrow-night|ayu-highlight)(?:-[a-f\d]+)?\.css(?:\?|$)/i.test(
              link.url,
            ),
        )
        .map(async (link) => {
          const value = await load(link.url, link.css);
          return link.media === "all"
            ? value
            : `@media ${link.media}{${value}}`;
        }),
    )
  ).join("\n");
  if (!css.trim()) throw new Error("Source has no authored stylesheets");
  // Restrict faces to a single supported source, preferring native TTF/OTF.
  // Browser/Kindle font installation is never used.
  const faces = await page.evaluate((value) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(value);
    const found: Array<{ raw: string; src: string }> = [];
    const visit = (list: CSSRuleList) =>
      Array.from(list).forEach((rule) => {
        if (rule instanceof CSSFontFaceRule)
          found.push({
            raw: rule.cssText,
            src: rule.style.getPropertyValue("src"),
          });
        else if (
          rule instanceof CSSMediaRule ||
          rule instanceof CSSSupportsRule
        )
          visit(rule.cssRules);
      });
    visit(sheet.cssRules);
    return found;
  }, css);
  const fontFiles = new Map<string, string>();
  const assets: Presentation["assets"] = [];
  for (const face of faces) {
    const urls = Array.from(
      face.src.matchAll(/url\(["']?([^"')]+)["']?\)/g),
      (match) => match[1],
    );
    const selected =
      urls.find((url) => /\.(?:ttf|otf)(?:[?#]|$)/i.test(url)) ??
      urls.find((url) => /\.(?:woff2?)(?:[?#]|$)/i.test(url)) ??
      urls[0];
    if (!selected) continue;
    if (!fontFiles.has(selected)) {
      const download = await resource(selected);
      const bytes = download.bytes!;
      const original = path.join(
        stage,
        "assets",
        `font-${sha256(bytes).slice(0, 16)}.source`,
      );
      fs.writeFileSync(original, bytes);
      const output = original.replace(/\.source$/, ".ttf");
      execFileSync(
        "calibre-debug",
        [
          "-e",
          fileURLToPath(
            new URL("../../scripts/unpack-source-font.py", import.meta.url),
          ),
          "--",
          original,
          output,
        ],
        { encoding: "utf8" },
      );
      fs.unlinkSync(original);
      const file = `assets/${path.basename(output)}`;
      fontFiles.set(selected, file);
      assets.push({ file, mime: "font/ttf" });
    }
    const filename = fontFiles.get(selected)!;
    // Normalize the face with the browser's parser before replacing it.
    css = await page.evaluate(
      ({ css, face, filename }) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        const visit = (list: CSSRuleList) =>
          Array.from(list).forEach((rule) => {
            if (
              rule instanceof CSSFontFaceRule &&
              rule.style.getPropertyValue("src") === face.src
            )
              rule.style.setProperty(
                "src",
                `url("${filename}") format("truetype")`,
              );
            else if (
              rule instanceof CSSMediaRule ||
              rule instanceof CSSSupportsRule
            )
              visit(rule.cssRules);
          });
        visit(sheet.cssRules);
        return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      },
      { css, face, filename },
    );
  }
  const references = Array.from(
    new Set(
      Array.from(
        css.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gi),
        (match) => match[1],
      ),
    ),
  );
  for (const url of references) {
    if (/^(?:data:|#|assets\/)/.test(url)) continue;
    const download = await resource(url);
    const ext = path.extname(new URL(url).pathname) || ".bin";
    const file = `assets/style-${sha256(download.bytes!).slice(0, 16)}${ext}`;
    fs.writeFileSync(path.join(stage, file), download.bytes!);
    assets.push({ file, mime: download.source.contentType!.split(";")[0] });
    css = css.replaceAll(url, file);
  }
  // The staged source CSS/fonts are also served into this isolated page for
  // accurate source samples and variable resolution; no site scripts run.
  await page.route("**/assets/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    const asset = assets.find((item) => path.basename(item.file) === name);
    if (asset)
      await route.fulfill({
        contentType: asset.mime,
        body: fs.readFileSync(path.join(stage, asset.file)),
      });
    else await route.abort();
  });
  console.log(
    `Authored presentation: ${assets.length} local font/style assets bundled`,
  );
  await page.evaluate((value) => {
    const style = document.createElement("style");
    style.textContent = value;
    document.head.append(style);
    // Force the initial font/layout request before checking readiness.
    void document.body.offsetHeight;
  }, css);
  await page.evaluate(async () => {
    // Explicit face loads avoid document.fonts readiness depending on blocked
    // original page requests or animation-frame polling in a scriptless page.
    await Promise.race([
      Promise.all(Array.from(document.fonts, (face) => face.load())),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Source font loading timed out")),
          60_000,
        ),
      ),
    ]);
  });
  const highlighter = await page.evaluate(() =>
    Array.from(document.scripts, (script) => script.src).find((url) =>
      /\/highlight(?:-[a-f\d]+)?\.js(?:\?|$)/i.test(url),
    ),
  );
  if (highlighter) {
    const script = await resource(highlighter);
    await page.evaluate((code) => {
      // Only the official source's isolated syntax parser is evaluated; book
      // scripts, editors and executable code examples remain disabled.
      // eslint-disable-next-line no-eval
      (0, eval)(code);
    }, script.bytes!.toString("utf8"));
    await page.evaluate(() => {
      const hljs = (
        globalThis as unknown as {
          hljs?: {
            highlightElement?: (node: Element) => void;
            highlightBlock?: (node: Element) => void;
            highlightAuto?: (
              value: string,
              languages?: string[],
            ) => { value: string };
            getLanguage?: (name: string) => unknown;
          };
        }
      ).hljs;
      const highlight = hljs?.highlightElement ?? hljs?.highlightBlock;
      if (!highlight)
        throw new Error("Source highlighter did not expose its expected API");
      // Existing author-supplied markup (including hidden playground lines)
      // is left intact. Highlight plain code, never execute code/playgrounds.
      document.querySelectorAll("pre code").forEach((code) => {
        if (!code.childElementCount) highlight.call(hljs, code);
        else {
          // Preserve author spans that hide setup lines, while still coloring
          // their text. Replacing the entire HTML would expose hidden lines.
          const language = /\blanguage-([\w-]+)/.exec(code.className)?.[1];
          if (
            !code.querySelector('[class*="hljs-"]') &&
            language &&
            hljs?.getLanguage?.(language) &&
            hljs.highlightAuto
          ) {
            const walker = document.createTreeWalker(
              code,
              NodeFilter.SHOW_TEXT,
            );
            const nodes: Text[] = [];
            while (walker.nextNode()) nodes.push(walker.currentNode as Text);
            for (const node of nodes) {
              const span = document.createElement("span");
              span.innerHTML = hljs.highlightAuto(node.textContent ?? "", [
                language,
              ]).value;
              node.replaceWith(...Array.from(span.childNodes));
            }
          }
          code.classList.add("hljs");
        }
      });
    });
  }
  // Ebook converters do not consistently understand SVG-only CSS properties.
  // Store the author's rendered paint as SVG presentation attributes so paths,
  // boxes, arrowheads and labels survive CSS flattening and rasterization.
  await page.evaluate(() => {
    document
      .querySelectorAll(
        "main svg path,main svg line,main svg rect,main svg circle,main svg ellipse,main svg polygon,main svg polyline,main svg text",
      )
      .forEach((element) => {
        const computed = getComputedStyle(element);
        const properties = [
          "fill",
          "fill-opacity",
          "stroke",
          "stroke-width",
          "stroke-opacity",
          "stroke-linecap",
          "stroke-linejoin",
          "stroke-dasharray",
          "stroke-dashoffset",
        ];
        if (element.tagName.toLowerCase() === "text")
          properties.push(
            "font-family",
            "font-size",
            "font-weight",
            "font-style",
            "text-anchor",
            "dominant-baseline",
          );
        for (const property of properties) {
          const value = computed.getPropertyValue(property);
          if (value) element.setAttribute(property, value);
        }
      });
  });
  // Materialize source break decisions before sectioning changes :first-child
  // /:first-of-type contexts. No new breaks or speed-related overrides.
  await page.evaluate(() => {
    document
      .querySelectorAll(
        "main h1,main h2,main h3,main h4,main p,main div,main pre,main table,main hr",
      )
      .forEach((element) => {
        const style = getComputedStyle(element);
        for (const property of [
          "page-break-before",
          "page-break-after",
          "page-break-inside",
        ])
          if (!["auto", ""].includes(style.getPropertyValue(property)))
            (element as HTMLElement).style.setProperty(
              property,
              style.getPropertyValue(property),
            );
      });
  });
  css = await page.evaluate(resolvePresentationCss, css);
  const context = await page.evaluate(() => {
    const attributes = (element: Element) =>
      Array.from(element.attributes)
        .filter((attr) => !/^on/i.test(attr.name))
        .map(
          (attr) =>
            `${attr.name}="${attr.value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`,
        )
        .join(" ");
    const main = document.querySelector("main")!;
    if (!main.id) main.id = "ebook-source-main";
    const wrappers = [];
    for (
      let element: Element | null = main;
      element && element !== document.body;
      element = element.parentElement
    )
      wrappers.unshift({
        tag: element.tagName.toLowerCase(),
        attributes: attributes(element),
      });
    const properties = [
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "line-height",
      "color",
      "background-color",
      "text-indent",
      "white-space",
      "page-break-before",
      "page-break-after",
      "padding-left",
      "border-left-width",
    ];
    const samples = [
      "main",
      "main h1",
      "main h2",
      "main p",
      "main pre",
      "main pre code",
      "main table",
      "main svg rect",
      "main svg line",
      "main svg text",
    ].flatMap((selector) => {
      const element = document.querySelector(selector);
      if (!element) return [];
      if (!element.id) {
        let index = 0;
        while (document.getElementById(`ebook-source-sample-${index}`)) index++;
        element.id = `ebook-source-sample-${index}`;
      }
      const computed = getComputedStyle(element);
      return [
        {
          selector: `#${CSS.escape(element.id)}`,
          styles: Object.fromEntries(
            (element instanceof SVGElement
              ? [
                  "stroke",
                  "stroke-width",
                  "stroke-opacity",
                  "fill",
                  "fill-opacity",
                  "stroke-dasharray",
                ]
              : properties
            ).map((name) => [name, computed.getPropertyValue(name)]),
          ),
        },
      ];
    });
    return {
      htmlAttributes: attributes(document.documentElement),
      bodyAttributes: attributes(document.body),
      wrappers,
      samples,
    };
  });
  return { ...context, css, assets };
}
