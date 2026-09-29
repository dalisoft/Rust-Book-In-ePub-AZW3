#!/usr/bin/env python3
"""Verify conversion preserves the complete staged book in EPUB spine order."""
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import posixpath
import re
import sys
import unicodedata
from xml.etree import ElementTree as ET
from zipfile import ZipFile


class Content(HTMLParser):
    def __init__(self):
        super().__init__()
        self.body = False
        self.text = []
        self.counts = Counter()

    def handle_starttag(self, tag, attrs):
        if tag == "body":
            self.body = True
        if self.body and tag in {"h1", "h2", "h3", "h4", "pre", "table", "img"}:
            self.counts[tag] += 1

    def handle_endtag(self, tag):
        if tag == "body":
            self.body = False

    def handle_data(self, data):
        if self.body:
            self.text.append(data)

    def normalized(self):
        # Converter cleanup removes discretionary wrapping markers, not text.
        return re.sub(r"\s+", "", unicodedata.normalize("NFKC", "".join(self.text))).replace("\u00ad", "").replace("\u200b", "").replace("\u2010", "-")


epub = Path(sys.argv[1])
original = Content()
original.feed((epub.parent / "stage/book.html").read_text())
converted = Content()
with ZipFile(epub) as archive:
    container = ET.fromstring(archive.read("META-INF/container.xml"))
    opf = next(node.attrib["full-path"] for node in container.iter() if node.tag.endswith("rootfile"))
    package = ET.fromstring(archive.read(opf))
    items = {node.attrib["id"]: node.attrib["href"] for node in package.iter() if node.tag.endswith("}item")}
    for node in package.iter():
        if node.tag.endswith("}itemref") and node.attrib.get("linear") != "no":
            filename = posixpath.normpath(posixpath.join(posixpath.dirname(opf), items[node.attrib["idref"]]))
            converted.feed(archive.read(filename).decode("utf8"))
# A reader-size split can turn one long table/pre into several whole fragments.
# Require identical text and no lost blocks, rather than rejecting extra fragments.
if original.normalized() != converted.normalized() or any(
        converted.counts[tag] < count for tag, count in original.counts.items()):
    raise SystemExit(f"{epub}: conversion changed book text or block counts: {original.counts} -> {converted.counts}")
print(f"{epub}: complete book text, headings, code, tables and images preserved")
