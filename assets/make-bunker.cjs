const sharp = require("sharp");
const path = require("path");
const dir = __dirname;

(async () => {
  // Icon: 1:1 → 500x500 PNG
  await sharp(path.join(dir, "bunker-icon.jpg"))
    .resize(500, 500, { fit: "cover", position: "centre" })
    .png()
    .toFile(path.join(dir, "bunker-icon-500.png"));

  // Header: crop the 16:9 source to a centered 3:1 band, then resize to 1500x500 PNG
  const src = sharp(path.join(dir, "bunker-header-16x9.jpg"));
  const meta = await src.metadata();
  const w = meta.width;
  const h = meta.height;
  const targetH = Math.round(w / 3); // 3:1 band full width
  const top = Math.max(0, Math.round((h - targetH) / 2));
  await sharp(path.join(dir, "bunker-header-16x9.jpg"))
    .extract({ left: 0, top, width: w, height: Math.min(targetH, h) })
    .resize(1500, 500, { fit: "fill" })
    .png()
    .toFile(path.join(dir, "bunker-header-1500x500.png"));

  for (const f of ["bunker-icon-500.png", "bunker-header-1500x500.png"]) {
    const m = await sharp(path.join(dir, f)).metadata();
    console.log(f, m.width + "x" + m.height, m.format);
  }
})();
