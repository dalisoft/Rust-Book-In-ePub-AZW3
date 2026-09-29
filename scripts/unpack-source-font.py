"""Losslessly unpack source webfonts to Kindle-supported SFNT; no installation."""
import sys
from fontTools.ttLib import TTFont

source, output = sys.argv[1:]
font = TTFont(source, recalcTimestamp=False)
font.flavor = None
# Keep all glyphs, names, copyright/license records and OpenType tables.
font.save(output)
font.close()
