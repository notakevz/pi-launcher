"""Render the Pi project logo (assets/icon.svg) to PNG and Windows ICO.

The icon is the Pi project logo, unmodified on a transparent background
(MIT License, Copyright (c) 2025 Mario Zechner; see THIRD_PARTY_NOTICES.md).
Requires Pillow only when rebuilding icons. No downloads or external artwork.
"""
from pathlib import Path
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
svg = ET.parse(root / "assets" / "icon.svg").getroot()
size = 1024
scale = size / float(svg.get("viewBox").split()[2])
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
for element in svg:
    if not isinstance(element.tag, str):  # comments
        continue
    kind = element.tag.rsplit("}", 1)[-1]
    fill = element.attrib["fill"]
    if kind == "rect":
        x, y, width, height = (float(element.attrib[key]) * scale
                               for key in ("x", "y", "width", "height"))
        radius = float(element.attrib.get("rx", "0")) * scale
        draw.rounded_rectangle((x, y, x + width, y + height), radius=radius, fill=fill)
    elif kind == "polygon":
        points = [tuple(float(value) * scale for value in point.split(","))
                  for point in element.attrib["points"].split()]
        draw.polygon(points, fill=fill)
    else:
        raise ValueError(f"Unsupported SVG element: {kind}")
icon = image.resize((256, 256), Image.Resampling.LANCZOS)
icon.save(root / "assets" / "icon.png")
icon.save(root / "assets" / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32),
          (48, 48), (64, 64), (128, 128), (256, 256)])
print("Generated project PNG/ICO from assets/icon.svg")
