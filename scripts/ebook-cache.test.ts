import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { getProjectRoot, loadConfig } from "../src/shared/config.ts";
import { test } from "node:test";
import pLimit from "p-limit";
import {
  artifactHash,
  prepareBuildPlan,
  readSnapshot,
  recipeHash,
  verifyRelease,
  sameSource,
  scanBook,
  type Release,
  type Snapshot,
  type Source,
} from "./ebook-cache.ts";
import {
  cachedImage,
  fetchSource,
  sha256,
} from "../src/shared/ebook-sources.ts";

const bytes = Buffer.alloc(2048, 7);
const artifact = { sha256: sha256(bytes), size: bytes.length };
function source(): Source {
  return {
    url: "https://example.test/print.html",
    finalUrl: "https://example.test/print.html",
    sha256: sha256("page"),
    recipe: sha256("recipe"),
    images: {},
    artifacts: { epub: artifact, azw3: artifact },
  };
}
function snapshot(keys = ["One", "Two"]): Snapshot {
  return {
    version: 2,
    sources: Object.fromEntries(keys.map((key) => [key, source()])),
  };
}
function release(keys = ["One", "Two"]): Release {
  return {
    tag_name: "release-test",
    assets: keys.flatMap((key) =>
      ["epub", "azw3"].map((format) => ({
        name: `${key}.${format}`,
        size: bytes.length,
        digest: `sha256:${artifact.sha256}`,
      })),
    ),
  };
}

test("unchanged complete release skips all builds and artifact downloads", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plan = await prepareBuildPlan(
    snapshot(),
    snapshot(),
    dir,
    dir,
    release(),
    async () => {
      assert.fail("Unchanged release must not download formats");
    },
  );
  assert.deepEqual(plan.buildKeys, []);
  assert.deepEqual(plan.reusedKeys, ["One", "Two"]);
});

test("one changed book does not download unchanged release formats", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const current = snapshot();
  current.sources.One.sha256 = sha256("edited page");
  const restored: string[] = [];
  const plan = await prepareBuildPlan(
    current,
    snapshot(),
    dir,
    dir,
    release(),
    async (key, folder) => {
      restored.push(key);
      fs.mkdirSync(folder, { recursive: true });
      for (const format of ["epub", "azw3"])
        fs.writeFileSync(path.join(folder, `${key}.${format}`), bytes);
    },
  );
  assert.deepEqual(plan.buildKeys, ["One"]);
  assert.deepEqual(plan.reusedKeys, ["Two"]);
  assert.deepEqual(restored, []);
  assert.equal(plan.snapshot.sources.Two.artifactRelease, "release-test");
});

test("corrupt downloaded cache rebuilds the affected book instead of reusing it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const current = snapshot();
  current.sources.One.recipe = sha256("new CSS");
  const remote = release();
  for (const asset of remote.assets) delete asset.digest;
  const plan = await prepareBuildPlan(
    current,
    snapshot(),
    dir,
    dir,
    remote,
    async (key, folder) => {
      fs.mkdirSync(folder, { recursive: true });
      for (const format of ["epub", "azw3"])
        fs.writeFileSync(
          path.join(folder, `${key}.${format}`),
          Buffer.alloc(2048, 8),
        );
    },
  );
  assert.deepEqual(plan.buildKeys, ["One", "Two"]);
  assert.deepEqual(plan.reusedKeys, []);
});

test("missing remote formats cannot yield a false unchanged result", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = release();
  remote.assets = remote.assets.filter((asset) => asset.name !== "One.azw3");
  const plan = await prepareBuildPlan(
    snapshot(),
    snapshot(),
    dir,
    dir,
    remote,
    async (key, folder) => {
      fs.mkdirSync(folder, { recursive: true });
      for (const format of ["epub", "azw3"])
        fs.writeFileSync(path.join(folder, `${key}.${format}`), bytes);
    },
  );
  assert.deepEqual(plan.buildKeys, ["One"]);
  assert.deepEqual(plan.reusedKeys, ["Two"]);
});

test("removing a configured book keeps remaining books without conversion", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plan = await prepareBuildPlan(
    snapshot(["One"]),
    snapshot(),
    dir,
    dir,
    release(),
    async (key, folder) => {
      fs.mkdirSync(folder, { recursive: true });
      for (const format of ["epub", "azw3"])
        fs.writeFileSync(path.join(folder, `${key}.${format}`), bytes);
    },
  );
  assert.deepEqual(plan.buildKeys, []);
  assert.deepEqual(plan.reusedKeys, ["One"]);
  assert.deepEqual(plan.removedKeys, ["Two"]);
});

test("legacy manifests seed a new cache instead of reusing unverified artifacts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "legacy.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, sources: {} }));
  assert.equal(readSnapshot(file), undefined);
  fs.writeFileSync(file, "{invalid JSON");
  assert.equal(readSnapshot(file), undefined);
});

test("recipe hashes invalidate CSS, dependency, converter, and per-book setting changes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-recipe-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = [
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
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "original");
  }
  const book = {
    print_url: "https://example.test/print.html",
    file_name: "test.pdf",
  };
  const before = recipeHash(dir, book);
  assert.notEqual(
    recipeHash(dir, { ...book, display_title: "Edited title" }),
    before,
  );
  assert.equal(recipeHash(dir, book), before);
  for (const file of [
    "src/shared/ebook-sections.ts",
    "src/shared/ebook-presentation.ts",
    "bun.lock",
    "scripts/ebook-toolchain.json",
  ]) {
    fs.writeFileSync(path.join(dir, file), "changed");
    assert.notEqual(recipeHash(dir, book), before, file);
    fs.writeFileSync(path.join(dir, file), "original");
  }
});

test("published assets must match the complete manifest by hash and size", () => {
  const remote = release();
  remote.assets.push({
    name: "source-fingerprints.json",
    size: artifact.size,
    digest: `sha256:${artifact.sha256}`,
  });
  assert.doesNotThrow(() => verifyRelease(snapshot(), remote, artifact));
  remote.assets[0].digest = `sha256:${sha256("corrupt")}`;
  assert.throws(
    () => verifyRelease(snapshot(), remote, artifact),
    /hash\/size mismatch/,
  );
});

test("delta releases keep earlier unchanged artifact locations without downloads", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const baseline = snapshot();
  baseline.sources.One.artifactRelease = "release-new";
  baseline.sources.Two.artifactRelease = "release-old";
  const remote = release(["One"]);
  remote.tag_name = "release-new";
  remote.related = {
    "release-old": { ...release(["Two"]), tag_name: "release-old" },
  };
  const current = snapshot();
  const plan = await prepareBuildPlan(
    current,
    baseline,
    dir,
    dir,
    remote,
    async () => assert.fail("No unchanged ebook download"),
  );
  assert.deepEqual(plan.buildKeys, []);
  assert.deepEqual(plan.reusedKeys, ["One", "Two"]);
  assert.equal(current.sources.Two.artifactRelease, "release-old");
  delete remote.related["release-old"];
  const missing = await prepareBuildPlan(
    snapshot(),
    baseline,
    dir,
    dir,
    remote,
    async () => assert.fail("Missing release must rebuild"),
  );
  assert.deepEqual(missing.buildKeys, ["Two"]);
});

test("delta publishing verifies only this release's books plus the full index", () => {
  const index = snapshot();
  index.publishedKeys = ["One"];
  index.sources.One.artifactRelease = "release-test";
  index.sources.Two.artifactRelease = "release-earlier";
  const remote = release(["One"]);
  remote.assets.push({
    name: "source-fingerprints.json",
    size: artifact.size,
    digest: `sha256:${artifact.sha256}`,
  });
  assert.doesNotThrow(() => verifyRelease(index, remote, artifact));
  index.sources.One.artifactRelease = "release-wrong";
  assert.throws(
    () => verifyRelease(index, remote, artifact),
    /another release/,
  );
});

test("finalizer uploads only a changed pair while indexing all unchanged books", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-delta-finalize-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = getProjectRoot(import.meta.url);
  const keys = Object.keys(loadConfig(import.meta.url).Books).sort();
  const changed = keys[0];
  const index = snapshot(keys);
  for (const value of Object.values(index.sources))
    value.artifactRelease = "release-2026-10-01";
  // Another book was already updated earlier today: verify it but don't upload it again.
  index.sources[keys[1]].artifactRelease = "release-2026-10-03";
  const folder = path.join(dir, changed);
  fs.mkdirSync(folder);
  for (const ext of ["epub", "azw3"])
    fs.writeFileSync(path.join(folder, `${changed}.${ext}`), bytes);
  fs.writeFileSync(
    path.join(folder, "manifest.json"),
    JSON.stringify({
      sourceSha256: index.sources[changed].sha256,
      sourceImages: {},
      sourceStyles: {
        "https://example.test/style.css": {
          resolvedUrl: "https://example.test/style.css",
          sha256: sha256("css"),
          contentType: "text/css",
        },
      },
    }),
  );
  const plan = {
    version: 1,
    sourceDir: dir,
    buildKeys: [changed],
    reusedKeys: keys.slice(1),
    removedKeys: [],
    snapshot: index,
  };
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/finalize-ebook-cache.ts"),
      `--plan=${dir}/plan.json`,
      `--output-dir=${dir}`,
      `--output=${dir}/index.json`,
      `--files=${dir}/files.txt`,
    ],
    { env: { ...process.env, BOOK_RELEASE_TAG: "release-2026-10-03" } },
  );
  const published = readSnapshot(path.join(dir, "index.json"));
  assert.ok(published);
  assert.deepEqual(published.publishedKeys, keys.slice(0, 2));
  assert.equal(Object.keys(published.sources).length, keys.length);
  assert.equal(
    published.sources[changed].artifactRelease,
    "release-2026-10-03",
  );
  assert.equal(
    published.sources[keys[2]].artifactRelease,
    "release-2026-10-01",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(dir, "files.txt"), "utf8").trim().split("\n"),
    [
      path.join(folder, `${changed}.epub`),
      path.join(folder, `${changed}.azw3`),
    ],
  );
  assert.deepEqual(
    artifactHash(path.join(folder, `${changed}.epub`)),
    artifact,
  );
});

test("downloads retry a truncated body after successfully receiving headers", async (t) => {
  let requests = 0;
  const expected = Buffer.from("complete-image-body");
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": expected.length,
    });
    response.flushHeaders();
    if (requests < 3) {
      response.write(expected.subarray(0, 3));
      setTimeout(() => response.destroy(), 20);
    } else response.end(expected);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetchSource(
    `http://127.0.0.1:${address.port}/image.png`,
  );
  assert.equal(requests, 3);
  assert.deepEqual(response.bytes, expected);
});

test("source scanner catches image-only edits and missing-image recovery", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let image = Buffer.from("image-v1");
  let missing = false;
  let stylesheet = Buffer.from("p{color:red}");
  let page = `<html><main><h1>Book</h1>${"content ".repeat(250)}<img src="/image.png"></main></html>`;
  const server = createServer((request, response) => {
    if (request.url === "/style.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(stylesheet);
    } else if (request.url === "/image.png") {
      response.writeHead(missing ? 404 : 200, { "content-type": "image/png" });
      response.end(missing ? "missing" : image);
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(page);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/print.html`;
  const imageUrl = new URL("/image.png", url).href;
  const book = { print_url: url, file_name: "test.pdf" };
  const baseline = await scanBook(
    "Test",
    book,
    url,
    sha256("recipe"),
    undefined,
    dir,
    pLimit(2),
  );
  baseline.images[imageUrl] = {
    resolvedUrl: imageUrl,
    sha256: sha256(image),
    contentType: "image/png",
  };
  const unchanged = await scanBook(
    "Test",
    book,
    url,
    baseline.recipe,
    baseline,
    dir,
    pLimit(2),
  );
  assert.ok(sameSource(baseline, unchanged));
  const styleUrl = new URL("/style.css", url).href;
  baseline.styles = {
    [styleUrl]: {
      resolvedUrl: styleUrl,
      sha256: sha256(stylesheet),
      contentType: "text/css",
    },
  };
  const sameStyles = await scanBook(
    "Test",
    book,
    url,
    baseline.recipe,
    baseline,
    dir,
    pLimit(2),
  );
  assert.ok(sameSource(baseline, sameStyles));
  stylesheet = Buffer.from("p{color:blue}");
  const changedStyles = await scanBook(
    "Test",
    book,
    url,
    baseline.recipe,
    baseline,
    dir,
    pLimit(2),
  );
  assert.equal(changedStyles.sha256, baseline.sha256);
  assert.ok(
    !sameSource(baseline, changedStyles),
    "stylesheet-only edits must rebuild the book",
  );
  stylesheet = Buffer.from("p{color:red}");
  image = Buffer.from("image-v2");
  const edited = await scanBook(
    "Test",
    book,
    url,
    baseline.recipe,
    baseline,
    dir,
    pLimit(2),
  );
  assert.equal(edited.sha256, baseline.sha256);
  assert.ok(!sameSource(baseline, edited));
  assert.equal(
    cachedImage(path.join(dir, "Test", "images"), imageUrl)?.source.sha256,
    sha256(image),
  );
  missing = true;
  await assert.rejects(
    scanBook("Test", book, url, baseline.recipe, baseline, dir, pLimit(2)),
  );
  await assert.rejects(
    scanBook("RustRFCs", book, url, baseline.recipe, baseline, dir, pLimit(2)),
    /Previously available image cannot be verified/,
  );
  const missingBaseline = structuredClone(baseline);
  missingBaseline.images[imageUrl] = {
    resolvedUrl: imageUrl,
    sha256: null,
    contentType: null,
  };
  const absent = await scanBook(
    "RustRFCs",
    book,
    url,
    baseline.recipe,
    missingBaseline,
    dir,
    pLimit(2),
  );
  assert.equal(absent.images[imageUrl].sha256, null);
  missing = false;
  const recovered = await scanBook(
    "RustRFCs",
    book,
    url,
    baseline.recipe,
    absent,
    dir,
    pLimit(2),
  );
  assert.ok(!sameSource(absent, recovered));
  assert.equal(recovered.images[imageUrl].sha256, sha256(image));
  page = page.replace("Book", "Edited Book");
  await scanBook("Test", book, url, baseline.recipe, baseline, dir, pLimit(2));
  const captured = JSON.parse(
    fs.readFileSync(path.join(dir, "Test", "page.json"), "utf8"),
  );
  assert.deepEqual(
    captured.verifiedImages,
    [],
    "Changed pages must not reuse stale image inputs",
  );
});
