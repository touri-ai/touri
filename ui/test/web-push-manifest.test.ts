import { readFile } from "node:fs/promises"
import { URL as FileUrl } from "node:url"
import { expect, it } from "vitest"

it("provides installable app metadata and real 192px and 512px icons", async () => {
  const [manifestFile, small, large] = await Promise.all([
    readFile(new FileUrl("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new FileUrl("../public/pwa-192.png", import.meta.url)),
    readFile(new FileUrl("../public/pwa-512.png", import.meta.url)),
  ])

  const manifest = JSON.parse(manifestFile)

  expect(manifest).toMatchObject({ id: "/", name: "touri", start_url: "/", scope: "/", display: "standalone" })
  expect(manifest.icons).toEqual([
    { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
    { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
  ])
  expect([small.readUInt32BE(16), small.readUInt32BE(20)]).toEqual([192, 192])
  expect([large.readUInt32BE(16), large.readUInt32BE(20)]).toEqual([512, 512])
})
