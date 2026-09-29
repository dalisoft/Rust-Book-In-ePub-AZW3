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
02:17 UTC, or manually. Each release includes a fingerprint manifest for the
official print pages. A scheduled run compares those pages with the latest
release and exits successfully without rebuilding or publishing when they are
unchanged. Pushes and manual runs always rebuild. A changed run validates both
formats for every configured book before publishing; its browser, package
store, and Calibre converter stay inside the checked-out project.
On CI, two process workers build independent books in separate output folders
and Calibre config directories. The large Rust RFCs book starts in its own
worker; the other worker builds the remaining books. Four workers were slower
for Rust RFCs on the four-core runner. Publication still waits for every book
and format check to pass. Set `BOOK_BUILD_WORKERS` to 1–4 to tune the count.

To copy *existing* Calibre metadata and cover into generated formats, provide
both `--calibre-library=/path/to/library` and
`--metadata-map=/path/to/local-calibre-map.json`. The map is a JSON object
from book keys to confirmed Calibre record IDs, for example
`{"RustPerformanceBook":134}`. It is ignored by Git because IDs are personal
and must be verified before use. Without it, only the source title and English
language are used; check authors and publication details before distributing
or importing those files. Generation does not modify the library. The Kindle
format is AZW3, not the older MOBI format.

EPUB styling is self-contained in `src/ebook-format.css`, so it works without
web fonts or network access. Easy Rust's redundant in-chapter contents list is
omitted because the EPUB navigation already contains the chapter links.
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
