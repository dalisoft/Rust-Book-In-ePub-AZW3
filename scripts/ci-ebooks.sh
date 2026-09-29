#!/bin/sh
set -eu

book_key=${1:-RustPerformanceBook}
case "$book_key" in
    all) book_option=--all ;;
    *[!A-Za-z0-9_-]*|'') echo "Invalid book key" >&2; exit 2 ;;
    *) book_option="--book=$book_key" ;;
esac

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"
CALIBRE_CONFIG_DIRECTORY=${CALIBRE_CONFIG_DIRECTORY:-$project_root/.cache/calibre-config}
export CALIBRE_CONFIG_DIRECTORY
mkdir -p "$CALIBRE_CONFIG_DIRECTORY"
output_dir=${BOOKS_OUTPUT_DIR:-$project_root/output/ebooks}
if [ -n "${CALIBRE_LIBRARY:-}" ] && [ -z "${METADATA_MAP:-}" ] ||
   [ -z "${CALIBRE_LIBRARY:-}" ] && [ -n "${METADATA_MAP:-}" ]; then
    echo "CALIBRE_LIBRARY and METADATA_MAP must be set together" >&2
    exit 2
fi
if [ "${CI:-}" = true ]; then
    calibre_bin="$project_root/.cache/calibre/calibre"
    [ -x "$calibre_bin/ebook-convert" ] || { echo "Project-local Calibre missing" >&2; exit 1; }
    export PATH="$calibre_bin:$PATH"
fi

command -v ebook-convert >/dev/null
bun run lint
bun run typecheck
bun run format:check
set -- "$book_option" "--output-dir=$output_dir"
if [ -n "${CHROMIUM_PATH:-}" ]; then
    set -- "$@" "--chromium=$CHROMIUM_PATH"
fi
if [ -n "${CALIBRE_LIBRARY:-}" ] && [ -n "${METADATA_MAP:-}" ]; then
    set -- "$@" "--calibre-library=$CALIBRE_LIBRARY" "--metadata-map=$METADATA_MAP"
fi
if [ "${CI:-}" = true ] && [ "$book_option" = --all ]; then
    bun run ebooks:workers "--output-dir=$output_dir"
else
    bun run ebooks "$@"
fi

found=0
for epub in "$output_dir"/*/*.epub; do
    [ -f "$epub" ] || continue
    found=1
    azw3=${epub%.epub}.azw3
    [ -s "$azw3" ]
    unzip -tq "$epub" >/dev/null
    python3 scripts/check-epub-links.py "$epub"
    python3 scripts/check-epub-style.py "$epub"
    if [ "$(basename "$epub")" = EasyRust.epub ]; then
        python3 scripts/check-easy-rust-style.py "$epub"
    fi
    ebook-meta "$epub" >/dev/null
    ebook-meta "$azw3" >/dev/null
done
[ "$found" -eq 1 ]
