#!/usr/bin/env python3
"""Check that Easy Rust's reader styling survives EPUB conversion."""

from pathlib import Path
import re
import sys
from zipfile import ZipFile


def check(epub: Path) -> None:
    with ZipFile(epub) as archive:
        css = "\n".join(archive.read(name).decode("utf-8") for name in archive.namelist() if name.endswith(".css"))
        pages = {
            name: archive.read(name).decode("utf-8")
            for name in archive.namelist()
            if name.endswith((".html", ".xhtml"))
        }

    required = ("Open Sans", "Source Code Pro", "@font-face")
    if any(rule not in css for rule in required):
        raise SystemExit(f"{epub}: expected EPUB styles are missing")
    if "@import" in css or "fonts.googleapis.com" in css:
        raise SystemExit(f"{epub}: EPUB styles require network access")
    if any(re.search(r"<pre\b[^>]*>\s*<pre\b", page) for page in pages.values()):
        raise SystemExit(f"{epub}: nested pre blocks remain")

    introduction = next(
        (page for page in pages.values() if 'id="writing-rust-in-easy-english"' in page),
        None,
    )
    if introduction is None:
        raise SystemExit(f"{epub}: Easy Rust introduction is missing")
    if not any('id="part-1---rust-in-your-browser"' in page for page in pages.values()):
        raise SystemExit(f"{epub}: first chapter is missing")
    if "<ul" not in introduction:
        raise SystemExit(f"{epub}: author's introductory contents list is missing")
    print(f"{epub}: offline styles, code blocks, and introduction verified")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: check-easy-rust-style.py EasyRust.epub")
    check(Path(sys.argv[1]))
