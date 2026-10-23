import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const MAGICK = process.env.MAGICK ?? "/opt/homebrew/bin/magick"
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = join(ROOT, "docs/design/touri-bull.png")
const ICONS = join(ROOT, "src-tauri/icons")
const ICONSET = join(ICONS, "icon.iconset")
const ALPHA_CUTOFF = "50%"
const TRAY_POINTS = [22, 44] as const
const ACTIVE_RED = "#dc2626"
const ACTIVE_DOT = "circle 38,7 42,7"
const CANVAS = 1024
const SQUARE = 824
const SQUARE_RADIUS = 185
const BULL_WIDTH = 520
const BG = "#171719"

const magick = (args: string[]): void => {
  execFileSync(MAGICK, args, { stdio: "inherit" })
}

const silhouette = (size: number, fill: string, out: string): void => {
  magick([
    SOURCE,
    "-trim",
    "+repage",
    "-alpha",
    "extract",
    "-threshold",
    ALPHA_CUTOFF,
    "-filter",
    "point",
    "-resize",
    `${size}x${size}`,
    "-background",
    "black",
    "-gravity",
    "center",
    "-extent",
    `${size}x${size}`,
    "-write",
    "mpr:mask",
    "+delete",
    "-size",
    `${size}x${size}`,
    `xc:${fill}`,
    "mpr:mask",
    "-alpha",
    "off",
    "-compose",
    "CopyOpacity",
    "-composite",
    "-depth",
    "8",
    "-define",
    "png:color-type=6",
    `PNG32:${out}.png`,
  ])
  magick([`${out}.png`, "-depth", "8", `RGBA:${out}.rgba`])
}

const trayAssets = (): void => {
  const [small, large] = TRAY_POINTS
  const template = join(ICONS, "tray-template")
  silhouette(small, "black", join(ICONS, "tray-template@1x"))
  silhouette(large, "black", template)
  const active = join(ICONS, "tray-active")
  magick([
    `${template}.png`,
    "+antialias",
    "-fill",
    ACTIVE_RED,
    "-draw",
    ACTIVE_DOT,
    "-depth",
    "8",
    `PNG32:${active}.png`,
  ])
  magick([`${active}.png`, "-depth", "8", `RGBA:${active}.rgba`])
}

const appMaster = (out: string): void => {
  const offset = (CANVAS - SQUARE) / 2

  magick([
    "-size",
    `${CANVAS}x${CANVAS}`,
    "xc:none",
    "-fill",
    BG,
    "-draw",
    `roundrectangle ${offset},${offset} ${offset + SQUARE - 1},${offset + SQUARE - 1} ${SQUARE_RADIUS},${SQUARE_RADIUS}`,
    "(",
    SOURCE,
    "-trim",
    "+repage",
    "-resize",
    `${BULL_WIDTH}x`,
    ")",
    "-gravity",
    "center",
    "-composite",
    "-depth",
    "8",
    `PNG32:${out}`,
  ])
}

const resized = (master: string, size: number, out: string): void => {
  magick([master, "-resize", `${size}x${size}`, "-depth", "8", `PNG32:${out}`])
}

const writeWebIcons = (master: string): void => {
  // This one-shot asset script has no live requests; both output sizes are fixed.
  const sizes = [192, 512]
  sizes.forEach((size) => {
    const destination = join(ROOT, "ui/public", `pwa-${size}.png`)
    magick([master, "-resize", `${size}x${size}`, "-strip", "-depth", "8", `PNG32:${destination}`])
  })
}

const appAssets = (): void => {
  const master = join(ICONS, "1024x1024.png")
  const flat: Record<string, number> = { "128x128.png": 128, "128x128@2x.png": 256, "32x32.png": 32 }
  const iconset: Record<string, number> = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
  }

  appMaster(master)
  writeWebIcons(master)
  copyFileSync(SOURCE, join(ROOT, "ui/public/touri-bull.png"))
  for (const [name, size] of Object.entries(flat)) resized(master, size, join(ICONS, name))
  magick([join(ICONS, "32x32.png"), join(ROOT, "ui/public/favicon.ico")])
  rmSync(ICONSET, { recursive: true, force: true })
  mkdirSync(ICONSET, { recursive: true })
  for (const [name, size] of Object.entries(iconset)) resized(master, size, join(ICONSET, name))
  execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", join(ICONS, "icon.icns")], { stdio: "inherit" })
}

trayAssets()
appAssets()
