#!/usr/bin/env python3
"""Check that an EPUB retained self-contained book and code styling."""

from __future__ import annotations

from pathlib import Path
from html.parser import HTMLParser
import posixpath
import re
import sys
from urllib.parse import urlsplit
from zipfile import ZipFile


class StylesheetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.stylesheets: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "link":
            return
        values = dict(attrs)
        if "stylesheet" in (values.get("rel") or "").split():
            self.stylesheets.append(values.get("href") or "")


def check(epub: Path) -> None:
    with ZipFile(epub) as archive:
        names = set(archive.namelist())
        css_files = [name for name in names if name.endswith(".css")]
        if not css_files:
            raise SystemExit(f"{epub}: no packaged CSS")
        css = "\n".join(archive.read(name).decode("utf-8") for name in css_files)
        if re.search(r"margin-block-start:\s*calc\(-50px\)", css):
            raise SystemExit(f"{epub}: browser-header offset can clip headings")
        if re.search(r":target[^{}]*\{[^}]*content:\s*[\"']»", css):
            raise SystemExit(f"{epub}: browser permalink decoration can alter heading layout")
        for css_name in css_files:
            sheet = archive.read(css_name).decode("utf-8")
            for ref in re.findall(r"url\(\s*['\"]?([^'\"\s)]+)", sheet):
                parsed = urlsplit(ref)
                if parsed.scheme == "data" or ref.startswith("#"):
                    continue
                if parsed.scheme or parsed.netloc:
                    raise SystemExit(f"{epub}: external CSS resource {ref}")
                target = posixpath.normpath(posixpath.join(posixpath.dirname(css_name), parsed.path))
                if target not in names:
                    raise SystemExit(f"{epub}: missing CSS resource {target}")
        pages = {
            name: archive.read(name).decode("utf-8")
            for name in names
            if name.endswith((".html", ".xhtml"))
        }
        for name, page in pages.items():
            if not re.search(r"<(?:h[1-6]|pre)\b", page):
                continue
            parser = StylesheetParser()
            parser.feed(page)
            if not parser.stylesheets:
                raise SystemExit(f"{epub}: {name} has no stylesheet link")
            linked_css = []
            for href in parser.stylesheets:
                parsed = urlsplit(href)
                if parsed.scheme or parsed.netloc:
                    raise SystemExit(f"{epub}: {name} uses an external stylesheet")
                css_name = posixpath.normpath(
                    posixpath.join(posixpath.dirname(name), parsed.path)
                )
                if css_name not in names:
                    raise SystemExit(f"{epub}: {name} links missing {css_name}")
                linked_css.append(archive.read(css_name).decode("utf-8"))
    if "font-family:" not in css:
        raise SystemExit(f"{epub}: book typography is missing")
    if "@import" in css or "fonts.googleapis.com" in css:
        raise SystemExit(f"{epub}: styling requires network access")
    if any(re.search(r"<pre\b[^>]*>\s*<pre\b", page) for page in pages.values()):
        raise SystemExit(f"{epub}: nested pre blocks remain")
    if any(re.search(r'class=["\'][^"\']*\bace_(?:editor|gutter|scroller|text-input)\b', page)
           for page in pages.values()):
        raise SystemExit(f"{epub}: browser-only Ace editor markup remains")
    if any(re.search(r"<iframe\b", page) for page in pages.values()):
        raise SystemExit(f"{epub}: browser-only iframe remains")
    if any(re.search(r"<(?:video|audio|source)\b", page) for page in pages.values()):
        raise SystemExit(f"{epub}: browser-only media element remains")
    print(f"{epub}: packaged typography, headings, and code styling verified")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: check-epub-style.py FILE.epub [FILE.epub ...]")
    for filename in sys.argv[1:]:
        check(Path(filename))
