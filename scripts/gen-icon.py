"""
gen-icon.py — 用 Python 标准库生成应用图标（512x512 PNG）。
网易红渐变圆角方块 + 白色八分音符。零第三方依赖。
用法：python scripts/gen-icon.py
"""
import struct
import zlib
import os
import math

SIZE = 512
W, H = SIZE, SIZE


def rounded_rect(px, py, x0, y0, x1, y1, r):
    """是否在圆角矩形内"""
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def lerp(a, b, t):
    return a + (b - a) * t


def dist_to_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def note_color(px, py):
    """返回音符像素的白色强度（0=背景）"""
    # 双八分音符：两个符头圆 + 两条符干 + 一条符梁
    heads = [(205, 348, 44), (332, 300, 44)]
    for cx, cy, r in heads:
        if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
            return 1.0
    # 符干（细矩形）
    stems = [(248, 318, 268, 172), (375, 278, 395, 132)]
    for x0, y0, x1, y1 in stems:
        if x0 <= px <= x1 and y1 <= py <= y0:
            return 1.0
    # 符梁（旋转粗线段）
    if dist_to_seg(px, py, 268, 172, 395, 132) <= 22:
        return 1.0
    # 符尾（第二根符干上部的尾巴）
    if dist_to_seg(px, py, 375, 132, 410, 105) <= 14:
        return 1.0
    return 0.0


def build_pixels():
    rows = []
    x0, y0, x1, y1, r = 16, 16, SIZE - 16, SIZE - 16, 104
    for py in range(H):
        row = bytearray()
        for px in range(W):
            if rounded_rect(px, py, x0, y0, x1, y1, r):
                t = py / H
                # 红渐变
                r_c = lerp(0xFF, 0xC8, t)
                g_c = lerp(0x55, 0x33, t)
                b_c = lerp(0x55, 0x30, t)
                w = note_color(px, py)
                if w > 0:
                    # 白色音符（带轻微抗锯齿边缘光晕）
                    rr = int(lerp(r_c, 255, w))
                    gg = int(lerp(g_c, 255, w))
                    bb = int(lerp(b_c, 255, w))
                    row += bytes((rr, gg, bb, 255))
                else:
                    row += bytes((int(r_c), int(g_c), int(b_c), 255))
            else:
                row += bytes((0, 0, 0, 0))  # 透明
        rows.append(bytes(row))
    return rows


def write_png(path, rows):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        c += struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    raw = b''.join(b'\x00' + r for r in rows)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'resources', 'icon.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_png(out, build_pixels())
    print('icon written:', os.path.abspath(out))
