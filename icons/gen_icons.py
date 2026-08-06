"""Generate FoodLens app icons (rounded square + plate/fork motif)."""

from pathlib import Path

from PIL import Image, ImageDraw


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_icon(size):
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    top_left = (20, 184, 166)   # teal
    bottom_right = (15, 23, 42) # dark navy
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            img.putpixel((x, y), lerp(top_left, bottom_right, t))

    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)

    overlay = Image.new("RGB", (size, size), (0, 0, 0))
    od = ImageDraw.Draw(overlay)

    # plate: white circle
    cx, cy, r = size * 0.5, size * 0.52, size * 0.30
    od.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(245, 250, 255))
    # inner rim
    rim = size * 0.20
    od.ellipse([cx - rim, cy - rim, cx + rim, cy + rim], outline=(210, 225, 240), width=max(2, size // 90))
    # fork lines
    line_color = (30, 60, 90)
    lw = max(3, size // 60)
    for dx in (-0.09, -0.03, 0.03, 0.09):
        od.line([cx + dx * size, cy - 0.14 * size, cx + dx * size, cy + 0.13 * size],
                fill=line_color, width=lw)
    od.line([cx, cy + 0.13 * size, cx, cy + 0.22 * size], fill=line_color, width=lw)

    # three food dots
    dot_color = (20, 184, 166)
    for dx, dy in ((-0.16, -0.16), (0.17, -0.10), (0.02, 0.18)):
        dr = size * 0.05
        od.ellipse([cx + dx * size - dr, cy + dy * size - dr, cx + dx * size + dr, cy + dy * size + dr],
                   fill=dot_color)

    img.paste(overlay, (0, 0), mask)
    return img


out = Path(__file__).parent
for size in (512, 192, 180):
    make_icon(size).save(out / f"icon-{size}.png")
print("icons generated")
