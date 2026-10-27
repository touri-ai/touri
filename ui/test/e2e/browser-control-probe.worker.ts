import "../../src/components/browserTakeover.worker"

type Probe = { id: number; x: number; y: number; green: boolean; clickAt: number }
let probe: Probe | null = null
self.addEventListener("message", (event: MessageEvent<{ type: string; probe?: Probe | null }>) => {
  if (event.data.type === "frame") probe = event.data.probe ?? null
})

// Sample the actual painted image, avoiding a second JPEG decode in the measuring page.
const drawImage = OffscreenCanvasRenderingContext2D.prototype.drawImage
OffscreenCanvasRenderingContext2D.prototype.drawImage = function (image: CanvasImageSource, x: number, y: number) {
  Reflect.apply(drawImage, this, [image, x, y])
  if (!probe?.clickAt) return
  const color = this.getImageData(Math.floor(probe.x), Math.floor(probe.y), 1, 1).data
  const matches = probe.green ? color[1] > color[2] : color[2] > color[1]
  if (!matches) return
  self.postMessage({
    type: "visual-probe",
    id: probe.id,
    latency: performance.timeOrigin + performance.now() - probe.clickAt,
  })
  probe = null
}
