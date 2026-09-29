#!/bin/sh
set -eu

library=${1:?Usage: verify-calibre-ebooks.sh LIBRARY MAP [OUTPUT_DIR]}
map=${2:?Usage: verify-calibre-ebooks.sh LIBRARY MAP [OUTPUT_DIR]}
output_dir=${3:-output/ebooks}
selected_key=${4:-}
db=$library/metadata.db
[ -f "$db" ] && [ -f "$map" ]
command -v jq >/dev/null
command -v sqlite3 >/dev/null
command -v ebook-meta >/dev/null

verify_dir=$(mktemp -d /private/tmp/rust-ebook-verify.XXXXXX)
case "$verify_dir" in
    /private/tmp/rust-ebook-verify.*) ;;
    *) echo "Unexpected temporary directory" >&2; exit 1 ;;
esac
trap 'rm -r -- "$verify_dir"' EXIT HUP INT TERM

jq -r --arg selected "$selected_key" 'to_entries[] | select($selected == "" or .key == $selected) | "\(.key)|\(.value)"' "$map" | while IFS='|' read -r key id; do
    case "$key" in *[!A-Za-z0-9_-]*|'') echo "Unsafe key: $key" >&2; exit 1 ;; esac
    case "$id" in *[!0-9]*|'') echo "Unsafe ID: $id" >&2; exit 1 ;; esac
    book_path=$(sqlite3 "$db" "select path from books where id=$id")
    expected_title=$(sqlite3 "$db" "select title from books where id=$id")
    [ -n "$book_path" ] && [ -n "$expected_title" ]
    cover="$library/$book_path/cover.jpg"
    [ -s "$cover" ]
    epub="$output_dir/$key/$key.epub"
    azw3="$output_dir/$key/$key.azw3"
    [ -s "$epub" ] && [ -s "$azw3" ]
    unzip -tq "$epub" >/dev/null
    for format in epub azw3; do
        if [ "$format" = epub ]; then book_file=$epub; else book_file=$azw3; fi
        book_title=$(ebook-meta "$book_file" | sed -n 's/^Title *: //p' | head -1)
        [ "$book_title" = "$expected_title" ] || {
            echo "$key: title mismatch in $format" >&2
            exit 1
        }
        extracted_cover="$verify_dir/$key-$format.jpg"
        ebook-meta "$book_file" "--get-cover=$extracted_cover" >/dev/null
        cmp -s "$cover" "$extracted_cover" || {
            echo "$key: cover mismatch in $format" >&2
            exit 1
        }
    done
    echo "$key: EPUB/AZW3, title, and covers verified"
done
