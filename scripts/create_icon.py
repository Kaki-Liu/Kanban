"""Generate the small geometric application icon. Optional asset authoring step."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / "resources"
root.mkdir(exist_ok=True)
image = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8, 8, 248, 248), radius=52, fill="#3869df")
for x, height in ((54, 137), (109, 104), (164, 72)):
    draw.rounded_rectangle((x, 57, x + 37, 57 + height), radius=9, fill="white")
image.save(root / "icon.png")
image.save(root / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
