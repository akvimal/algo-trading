"""Regenerates public/icon-192.png and public/icon-512.png (the PWA install icons) from the
same design as public/icon.svg, with the standard library only (no Pillow): a dark tile, a
raised card, an up-trending line and a green end dot. Run from systems/web/frontend:

    python scripts/make-icons.py

The design is drawn full-bleed on the dark background (nothing important within the outer
~10%), so the same PNG also works as the "maskable" icon."""

import math
import struct
import zlib
from pathlib import Path

BG = (14, 19, 25)
CARD = (21, 27, 35)
LINE = (42, 52, 66)
BLUE = (106, 169, 255)
GREEN = (79, 211, 168)
SS = 3  # supersampling for smooth edges


def in_round_rect(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r and x0 <= x <= x1 and y0 <= y <= y1


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size: int) -> bytes:
    k = size / 512.0
    poly = [(96, 344), (192, 248), (264, 296), (416, 140)]
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            acc = [0, 0, 0]
            for sj in range(SS):
                for si in range(SS):
                    x = (i + (si + 0.5) / SS) / k
                    y = (j + (sj + 0.5) / SS) / k
                    c = BG
                    if in_round_rect(x, y, 48, 48, 464, 464, 72):
                        c = LINE if not in_round_rect(x, y, 52, 52, 460, 460, 68) else CARD
                    if any(dist_to_segment(x, y, *poly[n], *poly[n + 1]) <= 16 for n in range(len(poly) - 1)):
                        c = BLUE
                    if math.hypot(x - 416, y - 140) <= 26:
                        c = GREEN
                    acc[0] += c[0]
                    acc[1] += c[1]
                    acc[2] += c[2]
            n = SS * SS
            row += bytes((acc[0] // n, acc[1] // n, acc[2] // n))
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path: Path, size: int) -> None:
    raw = render(size)

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


if __name__ == "__main__":
    public = Path(__file__).resolve().parent.parent / "public"
    for s in (192, 512):
        write_png(public / f"icon-{s}.png", s)
        print("wrote", public / f"icon-{s}.png")
