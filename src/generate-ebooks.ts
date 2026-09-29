import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { chromium, type APIRequestContext } from "playwright";
import { getProjectRoot, loadConfig } from "./shared/config.ts";
import { normalizeHttpUrl } from "./shared/url.ts";

type Args = {
  books: string[];
  all: boolean;
  outputDir: string;
  calibreLibrary?: string;
  metadataMap?: string;
  chromiumPath?: string;
};

const root = getProjectRoot(import.meta.url);
const config = loadConfig(import.meta.url);
const ebookCss = fs.readFileSync(
  path.join(root, "src", "ebook-format.css"),
  "utf8",
);

function options(): Args {
  const args: Args = {
    books: [],
    all: false,
    outputDir: path.join(root, "output", "ebooks"),
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--all") args.all = true;
    else if (arg.startsWith("--book=")) args.books.push(arg.slice(7));
    else if (arg.startsWith("--output-dir="))
      args.outputDir = path.resolve(arg.slice(13));
    else if (arg.startsWith("--calibre-library="))
      args.calibreLibrary = path.resolve(arg.slice(18));
    else if (arg.startsWith("--metadata-map="))
      args.metadataMap = path.resolve(arg.slice(15));
    else if (arg.startsWith("--chromium="))
      args.chromiumPath = path.resolve(arg.slice(11));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.books.length === 0 && !args.all) {
    throw new Error("Specify --book=KEY (repeatable) or --all");
  }
  if (Boolean(args.calibreLibrary) !== Boolean(args.metadataMap)) {
    throw new Error("Use --calibre-library and --metadata-map together");
  }
  return args;
}

function safeName(key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Unsafe book key: ${key}`);
  return key;
}

function mimeExtension(url: string, contentType: string): string {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext))
    return ext;
  if (contentType.includes("svg")) return ".svg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("webp")) return ".webp";
  throw new Error(`Unrecognized image type: ${contentType} from ${url}`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
}

async function fetchImage(request: APIRequestContext, url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await request.get(url, { timeout: 45_000 });
      if (
        ![408, 429, 500, 502, 503, 504].includes(response.status()) ||
        attempt === 2
      )
        return response;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw new Error(`Image retry exhausted: ${url}`);
}

function runConvert(
  input: string,
  output: string,
  extra: string[],
  logFile: string,
): void {
  const result = spawnSync("ebook-convert", [input, output, ...extra], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(logFile, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (
    result.error ||
    result.status !== 0 ||
    !fs.existsSync(output) ||
    fs.statSync(output).size < 1024
  ) {
    throw new Error(
      `Conversion failed for ${output}; see ${logFile}: ${result.error ?? result.status}`,
    );
  }
}

function calibreMetadata(
  key: string,
  args: Args,
  map: Record<string, number>,
): { opf: string; cover: string; title: string } | undefined {
  if (!args.calibreLibrary) return undefined;
  const id = map[key];
  if (!Number.isInteger(id))
    throw new Error(`No Calibre ID mapping for ${key}`);
  const db = path.join(args.calibreLibrary, "metadata.db");
  const rows = JSON.parse(
    execFileSync(
      "sqlite3",
      ["-json", db, `select title,path from books where id=${id}`],
      {
        encoding: "utf8",
      },
    ),
  ) as Array<{ title: string; path: string }>;
  if (rows.length !== 1)
    throw new Error(`Calibre ID ${id} is missing or ambiguous`);
  const folder = path.join(args.calibreLibrary, rows[0].path);
  const opf = path.join(folder, "metadata.opf");
  const cover = path.join(folder, "cover.jpg");
  if (!fs.existsSync(opf) || !fs.existsSync(cover))
    throw new Error(`Missing Calibre metadata/cover for ${key}`);
  return { opf, cover, title: rows[0].title };
}

async function main(): Promise<void> {
  const args = options();
  const map = args.metadataMap
    ? (JSON.parse(fs.readFileSync(args.metadataMap, "utf8")) as Record<
        string,
        number
      >)
    : {};
  const keys = args.all ? Object.keys(config.Books) : args.books;
  for (const key of keys) {
    safeName(key);
    if (!config.Books[key]) throw new Error(`Unknown book key: ${key}`);
  }
  fs.mkdirSync(args.outputDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    ...(args.chromiumPath ? { executablePath: args.chromiumPath } : {}),
  });
  const failures: string[] = [];
  try {
    for (const key of keys) {
      const book = config.Books[key];
      const url = normalizeHttpUrl(book.print_url);
      const folder = path.join(args.outputDir, key);
      const stage = path.join(folder, "stage");
      fs.mkdirSync(path.join(stage, "assets"), { recursive: true });
      // Print pages contain the full book in static HTML. Disabling scripts
      // prevents interactive editors (notably Ace) from replacing code with
      // browser-only controls that EPUB readers cannot render correctly.
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        console.log(`${key}: fetching ${url}`);
        const page = await context.newPage();
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });
        if (!response?.ok())
          throw new Error(`HTTP ${response?.status() ?? "no response"}`);
        const extracted = await page.evaluate((bookKey) => {
          const main = document.querySelector("main");
          if (!main) throw new Error("No <main> book content found");
          const body = main.cloneNode(true) as HTMLElement;
          body
            .querySelectorAll(
              "script,style,nav,button,.buttons,.nav-chapters,.mobile-nav-chapters",
            )
            .forEach((node) => node.remove());
          body.querySelectorAll("a.header").forEach((link) => {
            const heading =
              link.querySelector("h1,h2,h3,h4,h5,h6") ??
              (link.parentElement?.matches("h1,h2,h3,h4,h5,h6")
                ? link.parentElement
                : null);
            if (link.id && heading && !heading.id) heading.id = link.id;
            if (link.id && !heading) {
              const marker = document.createElement("span");
              marker.id = link.id;
              link.before(marker);
            }
            link.replaceWith(...Array.from(link.childNodes));
          });
          if (bookKey === "EasyRust") {
            // The print page embeds a full contents list in the introduction.
            // EPUB navigation already provides the same links without a long
            // unstyled list interrupting the first chapter.
            const heading = body.querySelector("#writing-rust-in-easy-english");
            const contents = heading?.nextElementSibling?.nextElementSibling;
            if (
              contents?.tagName === "UL" &&
              contents.querySelectorAll("li").length > 50
            )
              contents.remove();
          }
          body.querySelectorAll("pre > pre").forEach((inner) => {
            const outer = inner.parentElement;
            if (outer?.childElementCount === 1) outer.replaceWith(inner);
          });
          body.querySelectorAll("iframe[src]").forEach((frame) => {
            const target = new URL(frame.getAttribute("src")!, location.href);
            if (target.hostname === "ghbtns.com") {
              const user = target.searchParams.get("user");
              const repo = target.searchParams.get("repo");
              if (user && repo) {
                target.href = `https://github.com/${encodeURIComponent(user)}/${encodeURIComponent(repo)}`;
              }
            }
            const paragraph = document.createElement("p");
            const link = document.createElement("a");
            link.href = target.href;
            link.textContent =
              target.hostname === "www.youtube.com"
                ? "Watch the video on YouTube"
                : target.hostname === "github.com"
                  ? "View the project on GitHub"
                  : "Open embedded content";
            paragraph.append(link);
            frame.replaceWith(paragraph);
          });
          body.querySelectorAll("video,audio").forEach((media) => {
            const sources = [
              media.getAttribute("src"),
              ...Array.from(media.querySelectorAll("source[src]"), (source) =>
                source.getAttribute("src"),
              ),
            ].filter((src): src is string => Boolean(src));
            const paragraph = document.createElement("p");
            for (const src of sources) {
              const link = document.createElement("a");
              link.href = new URL(src, location.href).href;
              link.textContent =
                media.tagName === "VIDEO"
                  ? "Watch video online"
                  : "Play audio online";
              paragraph.append(link);
            }
            media.replaceWith(paragraph);
          });
          body.querySelectorAll("img[src]").forEach((img) => {
            const url = new URL(img.getAttribute("src")!, location.href);
            if (
              url.hostname === "img.shields.io" &&
              url.pathname.startsWith("/github/stars/")
            ) {
              const link = document.createElement("a");
              link.href = `https://github.com/${url.pathname.slice("/github/stars/".length)}`;
              link.textContent =
                img.getAttribute("alt") || "View project on GitHub";
              img.replaceWith(link);
            }
          });
          body.querySelectorAll("[style]").forEach((node) => {
            const inlineStyle = node.getAttribute("style") ?? "";
            node.setAttribute(
              "style",
              inlineStyle.replace(/var\(--[^,]+,\s*([^)]+)\)/g, "$1"),
            );
          });
          const normalizeFragment = (id: string) =>
            id
              .normalize("NFKC")
              .replace(/[\uFE0E\uFE0F?]/g, "")
              .toLowerCase();
          const normalizedIds = new Map<string, string>();
          const ambiguousIds = new Set<string>();
          body.querySelectorAll("[id]").forEach((node) => {
            const id = node.id;
            const normalized = normalizeFragment(id);
            if (
              normalizedIds.has(normalized) &&
              normalizedIds.get(normalized) !== id
            )
              ambiguousIds.add(normalized);
            else normalizedIds.set(normalized, id);
          });
          const normalizeHeading = (title: string) =>
            title.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
          const headingIds = new Map<string, string>();
          const ambiguousHeadings = new Set<string>();
          body
            .querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")
            .forEach((heading) => {
              const text = normalizeHeading(heading.textContent ?? "");
              if (headingIds.has(text) && headingIds.get(text) !== heading.id)
                ambiguousHeadings.add(text);
              else headingIds.set(text, heading.id);
            });
          const bookPath = new URL(".", location.href).pathname;
          const disabledLocalLinks: string[] = [];
          body.querySelectorAll("a[href]").forEach((link) => {
            const raw = link.getAttribute("href");
            if (!raw || raw.startsWith("mailto:")) return;
            const absolute = new URL(raw, location.href);
            const withinBook =
              absolute.origin === location.origin &&
              absolute.pathname.startsWith(bookPath);
            let targetId = "";
            try {
              targetId = decodeURIComponent(absolute.hash.slice(1));
            } catch {
              targetId = absolute.hash.slice(1);
            }
            const normalized = normalizeFragment(targetId);
            const headingText = normalizeHeading(link.textContent ?? "");
            const localId =
              targetId && body.querySelector(`#${CSS.escape(targetId)}`)
                ? targetId
                : !ambiguousIds.has(normalized)
                  ? normalizedIds.get(normalized)
                  : undefined;
            const textMatchedId = !ambiguousHeadings.has(headingText)
              ? headingIds.get(headingText)
              : undefined;
            if (withinBook && targetId && (localId || textMatchedId)) {
              link.setAttribute("href", `#${localId ?? textMatchedId}`);
            } else if (withinBook && targetId) {
              disabledLocalLinks.push(absolute.href);
              link.replaceWith(...Array.from(link.childNodes));
            } else {
              link.setAttribute("href", absolute.href);
            }
          });
          const images: Array<{
            placeholder: string;
            url: string;
            alt: string;
          }> = [];
          body.querySelectorAll("img").forEach((img, index) => {
            const raw = img.getAttribute("src") ?? img.getAttribute("data-src");
            if (!raw) return;
            const placeholder = `IMAGE_PLACEHOLDER_${index}_END`;
            images.push({
              placeholder,
              url: new URL(raw, location.href).href,
              alt: img.getAttribute("alt") ?? "",
            });
            img.setAttribute("src", placeholder);
            img.removeAttribute("srcset");
          });
          return {
            html: body.innerHTML,
            title:
              document.title.trim() ||
              body.querySelector("h1")?.textContent?.trim() ||
              "Untitled Book",
            chapters: body.querySelectorAll("h1").length,
            sections: body.querySelectorAll("h2").length,
            images,
            disabledLocalLinks,
          };
        }, key);
        if (extracted.chapters < 1 || extracted.html.length < 2000)
          throw new Error("Book content too small");
        if (extracted.disabledLocalLinks.length)
          console.warn(
            `${key}: disabled ${extracted.disabledLocalLinks.length} stale source links`,
          );
        let html = extracted.html;
        const downloadedImages = new Map<string, string>();
        const unavailableImages = new Map<string, string>();
        const linkUnavailableImage = (
          image: (typeof extracted.images)[number],
        ) => {
          const label = image.alt || "image from the source book";
          const tag = new RegExp(
            `<img\\b[^>]*src="${image.placeholder}"[^>]*>`,
          );
          if (!tag.test(html))
            throw new Error(`Missing image placeholder: ${image.placeholder}`);
          html = html.replace(
            tag,
            () =>
              `<a href="${escapeHtml(image.url)}">[Image unavailable: ${escapeHtml(label)}]</a>`,
          );
        };
        for (const [index, image] of extracted.images.entries()) {
          const existing = downloadedImages.get(image.url);
          if (existing) {
            html = html.replace(image.placeholder, existing);
            continue;
          }
          if (unavailableImages.has(image.url)) {
            linkUnavailableImage(image);
            continue;
          }
          let bytes: Buffer;
          let name: string;
          try {
            let assetUrl = image.url;
            let assetResponse = await fetchImage(context.request, assetUrl);
            if (
              assetResponse.status() === 404 &&
              new URL(assetUrl).hostname === "rawgit.com"
            ) {
              assetUrl = `https://raw.githubusercontent.com${new URL(assetUrl).pathname}`;
              assetResponse = await fetchImage(context.request, assetUrl);
            }
            if (
              assetResponse.status() === 404 &&
              book.ebook_image_fallback_prefix &&
              book.ebook_image_fallback_base &&
              assetUrl.startsWith(book.ebook_image_fallback_prefix)
            ) {
              assetUrl = new URL(
                assetUrl.slice(book.ebook_image_fallback_prefix.length),
                book.ebook_image_fallback_base,
              ).href;
              assetResponse = await fetchImage(context.request, assetUrl);
            }
            if (
              key === "RustRFCs" &&
              new URL(assetUrl).protocol === "http:" &&
              (!assetResponse.ok() ||
                !assetResponse
                  .headers()
                  ["content-type"]?.toLowerCase()
                  .startsWith("image/"))
            ) {
              assetUrl = assetUrl.replace(/^http:/, "https:");
              assetResponse = await fetchImage(context.request, assetUrl);
            }
            if (!assetResponse.ok())
              throw new Error(
                `Image HTTP ${assetResponse.status()}: ${assetUrl}`,
              );
            const contentType = assetResponse.headers()["content-type"] ?? "";
            if (!contentType.toLowerCase().startsWith("image/"))
              throw new Error(`Non-image asset: ${assetUrl}`);
            bytes = await assetResponse.body();
            if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024)
              throw new Error(`Invalid image size: ${assetUrl}`);
            name = `${String(index + 1).padStart(4, "0")}${mimeExtension(image.url, contentType)}`;
          } catch (error) {
            if (key !== "RustRFCs") throw error;
            unavailableImages.set(image.url, String(error).split("\n")[0]);
            linkUnavailableImage(image);
            continue;
          }
          fs.writeFileSync(path.join(stage, "assets", name), bytes);
          const localPath = `assets/${name}`;
          downloadedImages.set(image.url, localPath);
          html = html.replace(image.placeholder, localPath);
        }
        const title = book.display_title ?? extracted.title;
        const htmlFile = path.join(stage, "book.html");
        fs.writeFileSync(
          htmlFile,
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${ebookCss}</style></head><body>${html}</body></html>`,
        );
        const metadata = calibreMetadata(key, args, map);
        const epub = path.join(folder, `${key}.epub`);
        const azw3 = path.join(folder, `${key}.azw3`);
        const metaArgs = metadata
          ? ["--from-opf", metadata.opf, "--cover", metadata.cover]
          : ["--title", title, "--language", "en"];
        const chapterXPath =
          extracted.chapters < 5 && extracted.sections >= 5
            ? '//*[name()="h2"]'
            : '//*[name()="h1"]';
        runConvert(
          htmlFile,
          epub,
          [
            ...metaArgs,
            "--chapter",
            chapterXPath,
            "--level1-toc",
            chapterXPath,
            "--chapter-mark",
            "none",
            "--dont-split-on-page-breaks",
            "--no-default-epub-cover",
          ],
          path.join(folder, "epub-convert.log"),
        );
        runConvert(
          epub,
          azw3,
          metadata
            ? ["--from-opf", metadata.opf, "--cover", metadata.cover]
            : [],
          path.join(folder, "azw3-convert.log"),
        );
        const manifest = {
          key,
          url,
          title: metadata?.title ?? title,
          sourceTitle: title,
          chapters: extracted.chapters,
          sections: extracted.sections,
          images: extracted.images.length,
          uniqueImages: downloadedImages.size,
          disabledLocalLinks: extracted.disabledLocalLinks,
          unavailableImages: Object.fromEntries(unavailableImages),
          calibreId: map[key] ?? null,
          files: { epub: fs.statSync(epub).size, azw3: fs.statSync(azw3).size },
        };
        fs.writeFileSync(
          path.join(folder, "manifest.json"),
          JSON.stringify(manifest, null, 2),
        );
        console.log(
          `${key}: EPUB and AZW3 generated (${extracted.chapters} chapters, ${extracted.images.length} images)`,
        );
      } catch (error) {
        failures.push(key);
        console.error(`${key}: ${error}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.length) throw new Error(`Failed books: ${failures.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
