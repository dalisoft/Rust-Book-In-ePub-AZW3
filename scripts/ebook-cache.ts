import fs from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import type { BookConfig, ImageSource } from "../src/shared/ebook-sources.ts";
import {
  cacheImage,
  downloadImage,
  fetchSource,
  sha256,
} from "../src/shared/ebook-sources.ts";

export type Artifact = { sha256: string; size: number };
export type Source = {
  url: string;
  finalUrl: string;
  sha256: string;
  recipe: string;
  images: Record<string, ImageSource>;
  styles?: Record<string, ImageSource>;
  artifacts?: { epub: Artifact; azw3: Artifact };
};
export type Snapshot = { version: 2; sources: Record<string, Source> };
export type BuildPlan = {
  version: 1;
  sourceDir: string;
  buildKeys: string[];
  reusedKeys: string[];
  removedKeys: string[];
  snapshot: Snapshot;
};
export type Release = {
  tag_name: string;
  assets: Array<{ name: string; size: number; digest?: string | null }>;
};

export function verifyRelease(
  snapshot: Snapshot,
  release: Release,
  manifest: Artifact,
): void {
  const expected: Record<string, Artifact> = {
    "source-fingerprints.json": manifest,
  };
  for (const [key, source] of Object.entries(snapshot.sources)) {
    if (!source.artifacts?.epub || !source.artifacts?.azw3)
      throw new Error(`Missing artifact fingerprints: ${key}`);
    for (const format of ["epub", "azw3"] as const)
      expected[`${key}.${format}`] = source.artifacts[format];
  }
  if (release.assets.length !== Object.keys(expected).length)
    throw new Error(
      "Release asset count does not match the complete book cache",
    );
  for (const [name, artifact] of Object.entries(expected)) {
    const assets = release.assets.filter((asset) => asset.name === name);
    if (
      assets.length !== 1 ||
      assets[0].size !== artifact.size ||
      assets[0].digest !== `sha256:${artifact.sha256}`
    )
      throw new Error(`Release asset missing or hash/size mismatch: ${name}`);
  }
}

export async function prepareBuildPlan(
  snapshot: Snapshot,
  baseline: Snapshot | undefined,
  sourceDir: string,
  outputDir: string,
  release: Release | undefined,
  restore: (key: string, folder: string) => Promise<void>,
): Promise<BuildPlan> {
  const plan: BuildPlan = {
    version: 1,
    sourceDir,
    buildKeys: [],
    reusedKeys: [],
    removedKeys: Object.keys(baseline?.sources ?? {}).filter(
      (key) => !snapshot.sources[key],
    ),
    snapshot,
  };
  const reusable: string[] = [];
  let verifiedWithoutDownload = true;
  for (const [key, source] of Object.entries(snapshot.sources)) {
    const previous = baseline?.sources[key];
    const artifacts = previous?.artifacts;
    let usable =
      sameSource(previous, source) && !!artifacts?.epub && !!artifacts?.azw3;
    if (usable && artifacts) {
      for (const format of ["epub", "azw3"] as const) {
        const local = path.join(outputDir, key, `${key}.${format}`);
        const asset = release?.assets.find(
          (item) => item.name === `${key}.${format}`,
        );
        if (
          release &&
          (!asset ||
            asset.size !== artifacts[format].size ||
            (asset.digest &&
              asset.digest !== `sha256:${artifacts[format].sha256}`))
        )
          usable = false;
        if (validArtifact(local, artifacts[format])) continue;
        if (!release) usable = false;
        if (!asset?.digest) verifiedWithoutDownload = false;
      }
    }
    if (usable) reusable.push(key);
    else plan.buildKeys.push(key);
  }
  if (
    !plan.buildKeys.length &&
    !plan.removedKeys.length &&
    verifiedWithoutDownload
  ) {
    for (const key of reusable)
      snapshot.sources[key].artifacts = baseline!.sources[key].artifacts;
    plan.reusedKeys = reusable;
    return plan;
  }
  const limit = pLimit(4);
  await Promise.all(
    reusable.map((key) =>
      limit(async () => {
        const artifacts = baseline!.sources[key].artifacts!;
        const folder = path.join(outputDir, key);
        const complete = () =>
          (["epub", "azw3"] as const).every((format) =>
            validArtifact(
              path.join(folder, `${key}.${format}`),
              artifacts[format],
            ),
          );
        try {
          if (!complete()) await restore(key, folder);
          if (!complete()) throw new Error("Artifact SHA-256/size mismatch");
          snapshot.sources[key].artifacts = artifacts;
          plan.reusedKeys.push(key);
        } catch (error) {
          console.warn(`${key}: cache unavailable; rebuilding: ${error}`);
          plan.buildKeys.push(key);
        }
      }),
    ),
  );
  plan.buildKeys.sort();
  plan.reusedKeys.sort();
  return plan;
}

export function recipeHash(root: string, book: BookConfig): string {
  const inputs = [
    "src/generate-ebooks.ts",
    "src/shared/ebook-sections.ts",
    "src/shared/ebook-presentation.ts",
    "scripts/unpack-source-font.py",
    "src/shared/config.ts",
    "src/shared/url.ts",
    "src/shared/ebook-sources.ts",
    "package.json",
    "bun.lock",
    "scripts/ebook-toolchain.json",
    "scripts/ci-ebooks.sh",
    "scripts/test-ebook-presentation.ts",
    "scripts/validate-ebooks.ts",
    "scripts/check-epub-links.py",
    "scripts/check-epub-style.py",
    "scripts/review-epub-style.mjs",
    "scripts/check-epub-content.py",
    "scripts/check-easy-rust-style.py",
  ].map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]);
  return sha256(
    JSON.stringify({
      inputs,
      book,
      nodeMajor: process.versions.node.split(".")[0],
    }),
  );
}

export async function scanBook(
  key: string,
  book: BookConfig,
  url: string,
  recipe: string,
  baseline: Source | undefined,
  sourceDir: string,
  imageLimit: ReturnType<typeof pLimit>,
): Promise<Source> {
  const response = await fetchSource(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = response.bytes;
  if (bytes.length < 1000 || !/<main(?:\s|>)/i.test(bytes.toString("utf8")))
    throw new Error(`${url}: response does not contain a print-book <main>`);
  const folder = path.join(sourceDir, key);
  fs.mkdirSync(folder, { recursive: true });
  const source: Source = {
    url,
    finalUrl: response.url,
    sha256: sha256(bytes),
    recipe,
    images: {},
    styles: {},
  };
  fs.writeFileSync(path.join(folder, "page.html"), bytes);
  // An unchanged page has exactly the same image references. Recheck their
  // bytes, including formerly missing RFC diagrams, to detect image-only edits.
  // Changed/new pages discover their images during the normal DOM extraction.
  if (
    baseline?.url === url &&
    baseline.sha256 === source.sha256 &&
    baseline.finalUrl === source.finalUrl
  ) {
    const images = await Promise.all(
      Object.keys(baseline.images).map((imageUrl) =>
        imageLimit(async () => {
          const image = await downloadImage(key, book, imageUrl);
          if (
            image.source.sha256 === null &&
            baseline.images[imageUrl].sha256 !== null
          )
            throw new Error(
              `Previously available image cannot be verified: ${imageUrl}`,
            );
          cacheImage(path.join(folder, "images"), imageUrl, image);
          return [imageUrl, image.source] as const;
        }),
      ),
    );
    source.images = Object.fromEntries(images);
    const styles = await Promise.all(
      Object.keys(baseline.styles ?? {}).map((styleUrl) =>
        imageLimit(async () => {
          const response = await fetchSource(styleUrl);
          const contentType =
            response.headers.get("content-type") ?? "application/octet-stream";
          if (
            !response.ok ||
            !response.bytes.length ||
            contentType.includes("text/html")
          )
            throw new Error(
              `Cannot verify authored stylesheet/font: ${styleUrl}`,
            );
          const download = {
            bytes: response.bytes,
            source: {
              resolvedUrl: response.url,
              sha256: sha256(response.bytes),
              contentType,
            },
          };
          cacheImage(path.join(folder, "styles"), styleUrl, download);
          return [styleUrl, download.source] as const;
        }),
      ),
    );
    source.styles = Object.fromEntries(styles);
  }
  fs.writeFileSync(
    path.join(folder, "page.json"),
    JSON.stringify({
      url,
      finalUrl: source.finalUrl,
      sha256: source.sha256,
      verifiedImages: Object.keys(source.images),
      verifiedStyles: Object.keys(source.styles ?? {}),
    }),
  );
  return source;
}

export function sameSource(a: Source | undefined, b: Source): boolean {
  return (
    !!a &&
    a.url === b.url &&
    a.finalUrl === b.finalUrl &&
    a.sha256 === b.sha256 &&
    a.recipe === b.recipe &&
    JSON.stringify(Object.entries(a.images).sort()) ===
      JSON.stringify(Object.entries(b.images).sort()) &&
    JSON.stringify(Object.entries(a.styles ?? {}).sort()) ===
      JSON.stringify(Object.entries(b.styles ?? {}).sort())
  );
}

export function artifactHash(file: string): Artifact {
  const bytes = fs.readFileSync(file);
  return { sha256: sha256(bytes), size: bytes.length };
}

export function validArtifact(file: string, expected: Artifact): boolean {
  if (!fs.existsSync(file)) return false;
  const actual = artifactHash(file);
  return actual.size === expected.size && actual.sha256 === expected.sha256;
}

export function readSnapshot(file: string): Snapshot | undefined {
  try {
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
    // Existing v1 releases have no image/recipe/output hashes and need one
    // complete rebuild to seed the integrity-checked per-book cache.
    if (snapshot.version !== 2) return undefined;
    if (!snapshot.sources || typeof snapshot.sources !== "object")
      throw new Error("Invalid source fingerprint cache");
    for (const [key, source] of Object.entries(snapshot.sources)) {
      if (
        !/^[A-Za-z0-9_-]+$/.test(key) ||
        typeof source.url !== "string" ||
        typeof source.finalUrl !== "string" ||
        !source.images ||
        typeof source.images !== "object" ||
        !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !/^[a-f0-9]{64}$/.test(source.recipe)
      )
        throw new Error(`Invalid cached source: ${key}`);
      for (const image of [
        ...Object.values(source.images),
        ...Object.values(source.styles ?? {}),
      ]) {
        if (
          !image ||
          typeof image.resolvedUrl !== "string" ||
          (image.sha256 !== null && !/^[a-f0-9]{64}$/.test(image.sha256)) ||
          (image.contentType !== null && typeof image.contentType !== "string")
        )
          throw new Error(`Invalid cached image: ${key}`);
      }
      for (const artifact of Object.values(source.artifacts ?? {})) {
        if (
          !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isInteger(artifact.size) ||
          artifact.size < 1024
        )
          throw new Error(`Invalid cached artifact: ${key}`);
      }
    }
    return snapshot;
  } catch (error) {
    console.warn(`Ignoring invalid fingerprint cache; rebuilding: ${error}`);
    return undefined;
  }
}
