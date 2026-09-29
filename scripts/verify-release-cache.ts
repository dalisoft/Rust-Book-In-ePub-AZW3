import fs from "node:fs";
import process from "node:process";
import {
  artifactHash,
  readSnapshot,
  verifyRelease,
  type Release,
} from "./ebook-cache.ts";

const [snapshotFile, releaseFile] = process.argv.slice(2);
if (!snapshotFile || !releaseFile || process.argv.length !== 4)
  throw new Error(
    "Usage: node scripts/verify-release-cache.ts FINGERPRINTS_JSON RELEASE_JSON",
  );
const snapshot = readSnapshot(snapshotFile);
if (!snapshot) throw new Error("Invalid published fingerprint cache");
const release = JSON.parse(fs.readFileSync(releaseFile, "utf8")) as Release;
verifyRelease(snapshot, release, artifactHash(snapshotFile));
console.log(
  `Release verified: ${release.assets.length} assets match their SHA-256/size fingerprints`,
);
