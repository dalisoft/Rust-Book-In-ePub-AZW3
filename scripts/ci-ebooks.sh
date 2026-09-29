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
    export PATH="$calibre_bin:$PATH"
fi

build_required=true
if [ -n "${BOOK_BUILD_PLAN:-}" ]; then
    build_required=$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).buildKeys.length > 0)' "$BOOK_BUILD_PLAN")
fi
if [ "$build_required" = true ]; then
    command -v ebook-convert >/dev/null
fi
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
    if [ -n "${BOOK_BUILD_PLAN:-}" ]; then
        bun run ebooks:workers "--output-dir=$output_dir" "--plan=$BOOK_BUILD_PLAN"
    else
        bun run ebooks:workers "--output-dir=$output_dir"
    fi
else
    bun run ebooks "$@"
fi

set -- "--output-dir=$output_dir"
if [ -n "${BOOK_BUILD_PLAN:-}" ]; then
    set -- "$@" "--plan=$BOOK_BUILD_PLAN"
fi
node scripts/validate-ebooks.ts "$@"
if [ -n "${BOOK_BUILD_PLAN:-}" ]; then
    node scripts/finalize-ebook-cache.ts "--plan=$BOOK_BUILD_PLAN" \
        "--output-dir=$output_dir" \
        --output=.cache/source-check/source-fingerprints.json \
        --files=.cache/source-check/release-files.txt
fi
