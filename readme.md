## Rust Books in EPUB and AZW3

Download the EPUB or AZW3 files from this fork's [releases](https://github.com/dalisoft/Rust-Book-In-ePub-AZW3/releases). This project is based on [Rust-Book-In-PDF](https://github.com/shirshak55/Rust-Book-In-PDF).

### Contributing

Feel free to send a pull request. We follow the Rust Code of Conduct.


### Development
To run this project, use [Node](https://nodejs.org/) 26+ and Bun 1.4.2.

```bash
git clone https://github.com/dalisoft/Rust-Book-In-ePub-AZW3.git
cd Rust-Book-In-ePub-AZW3
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/playwright"
bun ci --ignore-scripts
bun run prepare
./node_modules/.bin/playwright install chromium
bun run start
```

This downloads all books listed in `config.toml`.

Use `DEBUG_ONLY_FIRST=true bun run start` to process only the first book during debugging.

Use `PRINT_SETTLE_MS=12000 bun run start` to enforce a longer fixed settle delay before printing.

Use `bun run generate-site` to regenerate `docs/index.html`.

### EPUB and AZW3 (experimental)

The EPUB/AZW3 builder uses the same official HTML `print_url` values as the PDF
builder. It creates separate files in `output/ebooks/` and never edits the PDF
releases or a Calibre library. It needs the project's Node dependencies, a
Chromium browser, and Calibre's `ebook-convert`/`ebook-meta` commands.

For a single book, run `bun run ebooks --book=RustPerformanceBook`; repeat
`--book=KEY` for several books, or use `--all`. On a machine with an existing
Chromium installation, pass `--chromium=/absolute/path/to/chromium`. The
`Publish EPUB and AZW3 When Sources Change` runs on pushes to `main`, daily at
00:00 UTC (05:00 GMT+5), or manually. GitHub's native cron is best-effort and
can be delayed; no Codex schedule or external trigger controls this CI.
The separate local book-update automation downloads releases into the source
folders and updates Calibre; it does not trigger or publish GitHub releases.
Each release includes a fingerprint manifest for the
official print pages. Every run hashes each page and its referenced image bytes,
then compares them with the latest release's `source-fingerprints.json` cache.
Only changed books rebuild and upload. Unchanged EPUB/AZW3 assets stay in their
original releases, verified against GitHub's SHA-256 and size metadata without
downloading the ebooks. An entirely unchanged run exits
successfully before installing a browser or converter, with no new release.
The cache also hashes each book's settings, styling, conversion and validation
code, dependency lockfile, Node major version, and pinned converter version;
changes to those inputs invalidate the affected books. Older releases seed the
cache with one full rebuild. Missing or corrupt cached formats rebuild safely.
New formats pass link, styling, archive, and metadata checks; reused formats
retain their matching validation recipe and are checked again by SHA-256.
Daily releases contain only updated books in both formats, plus the complete
`source-fingerprints.json` index. Each indexed book has an `artifactRelease`
tag locating its latest EPUB/AZW3 pair; `publishedKeys` lists this day's books.
For a complete collection, follow those tags rather than downloading only the
newest release's ebook assets. Retain referenced older releases: deleting one
invalidates that book's cache and causes a safe rebuild. Repeated updates on
the same day use one `release-YYYY-MM-DD` tag and retain earlier updates that
day. Legacy full-collection releases remain supported without a forced rebuild.
The browser, package store, and converter stay inside the checked-out project.
On CI, four process workers build independent books in separate output folders
and converter config directories. The large Rust RFCs book starts first, and
all four workers share the remaining books. Large print pages are pre-sectioned
into bounded, intact HTML blocks with cross-section anchors repaired before
conversion. Books over 5 MiB of staged HTML use supported uncompressed AZW3
and avoid redundant web-print page splits: content, images and typography are
preserved, at the cost of a larger AZW3 file. Full staged text and block counts
are checked against the EPUB in reading order. Publication still
waits for every book and format check to pass. Set `BOOK_BUILD_WORKERS` to 1–4
to tune the count.

For a genuine cold-build measurement, manually dispatch the workflow with
`force_rebuild` enabled. This fetches fresh sources and images and rebuilds all
configured books without restoring any release artifacts. Conversion-stage
timings are printed in the build log. Normal daily runs still skip unchanged
books.

Source checks save the fetched pages and images for conversion, so a book builds
from the same bytes that were hashed instead of fetching its page twice. Image
downloads and validation run concurrently within bounded limits. Missing Rust
RFC diagrams are rechecked and remain labeled source links until available.

To copy *existing* Calibre metadata and cover into generated formats, provide
both `--calibre-library=/path/to/library` and
`--metadata-map=/path/to/local-calibre-map.json`. The map is a JSON object
from book keys to confirmed Calibre record IDs, for example
`{"RustPerformanceBook":134}`. It is ignored by Git because IDs are personal
and must be verified before use. Without it, only the source title and English
language are used; check authors and publication details before distributing
or importing those files. Generation does not modify the library. The Kindle
format is AZW3, not the older MOBI format.

EPUB styling comes from each author's print/light stylesheets, not a replacement
theme. The builder bundles source fonts and CSS images for offline use, resolves
CSS variables for reader compatibility, and retains intentional page breaks,
heading hierarchy, code indentation, syntax colors, and introductory contents.
WOFF fonts are losslessly unpacked into Kindle-compatible SFNT containers using
the temporary converter's font tooling; no system fonts are installed.
Source styles/font/highlighter hashes participate in daily change detection.
Converter font rescaling, minimum line-height, and artificial page margins are
disabled. Reflowable EPUB/AZW3 pagination depends on the reader and screen;
it does not reproduce fixed PDF page numbers. Source presentation takes priority
over build-time targets.
The builder reads static print HTML with page scripts disabled, preventing
interactive code editors from injecting browser-only controls into the book.
Embedded web widgets become ordinary links, which remain usable in EPUB and
AZW3 readers.

For locally mapped books, run
`sh scripts/verify-calibre-ebooks.sh /path/to/library /path/to/local-calibre-map.json`
to check that both formats open, EPUB ZIP integrity passes, titles match the
Calibre records, and embedded covers are byte-for-byte identical. Inspect the
conversion logs and individual source licenses before publishing artifacts.
The CI entry script also checks every packaged EPUB hyperlink and navigation
target, including links back to chapters that should work offline.
It also checks that the offline typography, heading, and code-block styling
survives conversion, and that nested code blocks do not remain.
It also rejects injected Ace editor markup and iframes. For a visual review
of packaged EPUB pages, run
`bun run review:ebooks output/ebooks output/review-style /path/to/chromium`.
This compares packaged rendering against captured source fonts, sizes, spacing,
colors, indentation and break decisions, and saves code-page screenshots.
In-book links are repaired when their target ID or unique heading can be
identified. Stale source links without a reliable target are rendered as plain
text and listed in each book's `manifest.json` under `disabledLocalLinks`.
External websites are not bundled into the book and require network access.
Some Rust RFC source diagrams are unavailable even in the upstream PDF. Their
locations remain in the EPUB as labeled source links; the build manifest
records which images could not be embedded.

### Support us

You can support us by starring the repo. As the book is written by other people, I can't take any financial support.

### Thanks,

-   Shirshak
-   TRPL team
-   Rustaceans
-   Contributors
