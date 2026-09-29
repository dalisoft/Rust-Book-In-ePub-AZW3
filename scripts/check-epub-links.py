#!/usr/bin/env python3
"""Report broken internal links and missing resources in an EPUB, no dependencies."""

from html.parser import HTMLParser
import json
from pathlib import Path
import posixpath
import sys
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile
from xml.etree import ElementTree


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = set()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        if tag == "a" and attrs.get("name"):
            self.ids.add(attrs["name"])
        for name in ("href", "src"):
            if attrs.get(name):
                self.refs.append((name, attrs[name]))


def inspect(epub: Path):
    manifest = epub.with_name("manifest.json")
    source = urlsplit(json.loads(manifest.read_text())["url"]) if manifest.exists() else None
    source_path = posixpath.dirname(source.path).rstrip("/") + "/" if source else None
    with ZipFile(epub) as archive:
        files = set(archive.namelist())
        pages = {}
        for filename in files:
            if filename.lower().endswith((".html", ".xhtml", ".htm")):
                parser = PageParser()
                parser.feed(archive.read(filename).decode("utf-8"))
                pages[filename] = parser

        refs = [(filename, kind, raw) for filename, page in pages.items() for kind, raw in page.refs]
        for filename in files:
            if filename.lower().endswith(".ncx"):
                root = ElementTree.fromstring(archive.read(filename))
                refs.extend(
                    (filename, "toc", node.attrib["src"])
                    for node in root.iter()
                    if node.tag.rsplit("}", 1)[-1] == "content" and "src" in node.attrib
                )

        checked = 0
        external = 0
        broken = []
        for filename, kind, raw in refs:
            parsed = urlsplit(raw)
            if parsed.scheme or parsed.netloc:
                external += 1
                if (source and parsed.scheme == source.scheme and parsed.netloc == source.netloc
                        and parsed.path.startswith(source_path) and parsed.fragment):
                    broken.append((filename, raw, "in-book link escapes to website"))
                continue
            target_file = posixpath.normpath(
                posixpath.join(posixpath.dirname(filename), unquote(parsed.path))
            ) if parsed.path else filename
            fragment = unquote(parsed.fragment)
            checked += 1
            if target_file not in files:
                broken.append((filename, raw, "missing file"))
            elif fragment and target_file in pages and fragment not in pages[target_file].ids:
                broken.append((filename, raw, "missing anchor"))

    print(f"{epub}: {checked} internal references, {external} external, {len(broken)} broken")
    for filename, raw, reason in broken[:100]:
        print(f"  {filename} -> {raw}: {reason}")
    if len(broken) > 100:
        print(f"  ... {len(broken) - 100} more")
    return bool(broken)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: check-epub-links.py FILE.epub [FILE.epub ...]")
    failed = False
    for filename in sys.argv[1:]:
        failed = inspect(Path(filename)) or failed
    raise SystemExit(failed)
