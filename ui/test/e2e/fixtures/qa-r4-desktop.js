// Deterministic VM frames: transparent before the guest paints, black for an empty desktop.
export default class QaDesktop extends EventTarget {
  viewOnly = true
  constructor(target) {
    super()
    this.target = target
    this.canvas = document.createElement("canvas")
    this.canvas.width = 320
    this.canvas.height = 200
    this.canvas.style.cssText = "width:100%;height:100%;object-fit:contain"
    target.append(this.canvas)
    this.timer = setTimeout(() => this.dispatchEvent(new Event("connect")), 10)
    this.sequence = 0
  }
  getImageData() {
    const ctx = this.canvas.getContext("2d")
    ctx.clearRect(0, 0, 320, 200)
    if (window.qaVmFrame !== "none") {
      ctx.fillStyle = window.qaVmFrame === "page" ? "#344a70" : "black"
      ctx.fillRect(0, 0, 320, 200)
      const image = ctx.getImageData(0, 0, 320, 200)
      image.data.set([++this.sequence % 255, 0x30, 0x40, 255], ((200 - 4) * 320 + 320 - 4) * 4)
      return image
    }
    return ctx.getImageData(0, 0, 320, 200)
  }
  disconnect() {
    clearTimeout(this.timer)
    this.target.replaceChildren()
  }
  blur() {}
  sendKey() {}
}
