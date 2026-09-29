import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.ts";

export type BookConfig = AppConfig["Books"][string];
export type ImageSource = {
  resolvedUrl: string;
  sha256: string | null;
  contentType: string | null;
};
export type ImageDownload = { source: ImageSource; bytes?: Buffer };

export function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function fetchSource(
  url: string,
  attempts = 3,
  timeout = 45_000,
): Promise<Response> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { "User-Agent": "Rust-Book-In-ePub-AZW3" },
      });
      if (![408, 429, 500, 502, 503, 504].includes(response.status))
        return response;
      if (attempt === attempts - 1) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === attempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw new Error(`Fetch retries exhausted: ${url}`);
}

export async function downloadImage(
  key: string,
  book: BookConfig,
  url: string,
): Promise<ImageDownload> {
  let resolvedUrl = url;
  try {
    // RFCs contain obsolete external HTTP diagrams. Try HTTPS first so a
    // blocked HTTP request cannot delay every otherwise unchanged daily run.
    const request = (imageUrl: string) => fetchSource(imageUrl);
    let response: Response;
    if (key === "RustRFCs" && resolvedUrl.startsWith("http:")) {
      resolvedUrl = resolvedUrl.replace(/^http:/, "https:");
      try {
        response = await request(resolvedUrl);
        if (
          !response.ok ||
          !response.headers.get("content-type")?.startsWith("image/")
        ) {
          await response.body?.cancel();
          throw new Error("HTTPS diagram unavailable");
        }
      } catch {
        resolvedUrl = url;
        response = await request(resolvedUrl);
      }
    } else response = await request(resolvedUrl);
    if (
      response.status === 404 &&
      new URL(resolvedUrl).hostname === "rawgit.com"
    ) {
      await response.body?.cancel();
      resolvedUrl = `https://raw.githubusercontent.com${new URL(resolvedUrl).pathname}`;
      response = await request(resolvedUrl);
    }
    if (
      response.status === 404 &&
      book.ebook_image_fallback_prefix &&
      book.ebook_image_fallback_base &&
      resolvedUrl.startsWith(book.ebook_image_fallback_prefix)
    ) {
      await response.body?.cancel();
      resolvedUrl = new URL(
        resolvedUrl.slice(book.ebook_image_fallback_prefix.length),
        book.ebook_image_fallback_base,
      ).href;
      response = await request(resolvedUrl);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
      await response.body?.cancel();
      throw new Error(
        `Image HTTP ${response.status} (${contentType}): ${resolvedUrl}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 25 * 1024 * 1024)
      throw new Error(`Invalid image size: ${resolvedUrl}`);
    return {
      source: { resolvedUrl, sha256: sha256(bytes), contentType },
      bytes,
    };
  } catch (error) {
    if (key !== "RustRFCs") throw error;
    console.warn(`${key}: unavailable source image ${url}: ${error}`);
    return { source: { resolvedUrl: url, sha256: null, contentType: null } };
  }
}

export function cacheImage(
  folder: string,
  url: string,
  image: ImageDownload,
): void {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, sha256(url));
  if (image.bytes) fs.writeFileSync(`${file}.bin`, image.bytes);
  fs.writeFileSync(`${file}.json`, JSON.stringify(image.source));
}

export function cachedImage(
  folder: string,
  url: string,
): ImageDownload | undefined {
  const file = path.join(folder, sha256(url));
  if (!fs.existsSync(`${file}.json`)) return undefined;
  const source = JSON.parse(
    fs.readFileSync(`${file}.json`, "utf8"),
  ) as ImageSource;
  if (source.sha256 === null) return { source };
  const bytes = fs.readFileSync(`${file}.bin`);
  if (sha256(bytes) !== source.sha256)
    throw new Error(`Corrupt cached image: ${url}`);
  return { source, bytes };
}
