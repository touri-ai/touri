// Deterministic framebuffer adapter for UI layout evidence. No VM or network is used.
export default class MockDesktop extends EventTarget {
  constructor(target) {
    super()
    this.target = target
    this.canvas = document.createElement("canvas")
    this.canvas.width = 1200
    this.canvas.height = 800
    this.canvas.style.cssText = "width:100%;height:100%;object-fit:contain;display:block"
    const screen = document.createElement("div")
    screen.append(this.canvas)
    target.append(screen)
    const styles = getComputedStyle(document.documentElement)
    const color = (token) => styles.getPropertyValue(token).trim()
    const ctx = this.canvas.getContext("2d")
    ctx.fillStyle = color("--surface-tool")
    ctx.fillRect(0, 0, 1200, 800)
    ctx.fillStyle = color("--surface-panel")
    ctx.fillRect(0, 0, 1200, 44)
    ctx.fillStyle = color("--text-secondary")
    ctx.font = "16px sans-serif"
    ctx.fillText("Computador do bot", 24, 28)
    ctx.fillText("touri · Área de trabalho", 968, 28)
    ctx.fillStyle = color("--surface-panel")
    ctx.fillRect(140, 150, 920, 500)
    ctx.strokeStyle = color("--border-default")
    ctx.strokeRect(140, 150, 920, 500)
    ctx.fillStyle = color("--surface-control")
    ctx.fillRect(140, 150, 920, 52)
    ctx.fillStyle = color("--text-primary")
    ctx.font = "18px sans-serif"
    ctx.fillText("Arquivos", 162, 183)
    ctx.fillStyle = color("--text-secondary")
    ctx.fillText("/workspace", 288, 183)
    ctx.font = "17px sans-serif"
    ctx.fillText("documentos", 182, 250)
    ctx.fillText("notas.md", 182, 299)
    ctx.fillText("planejamento.json", 182, 348)
    ctx.fillText("resultados.csv", 182, 397)
    ctx.fillStyle = color("--accent-brand")
    ctx.fillRect(140, 698, 160, 4)
    this.sequence = 0
    this.connectTimer = setTimeout(() => this.dispatchEvent(new Event("connect")), 40)
  }
  getImageData() {
    // The connecting scenario has not received its first guest frame yet.
    if (new URLSearchParams(location.search).has("connecting")) return new ImageData(1200, 800)

    const image = this.canvas.getContext("2d").getImageData(0, 0, 1200, 800)
    image.data.set([++this.sequence % 255, 0x30, 0x40, 255], ((800 - 4) * 1200 + 1200 - 4) * 4)
    return image
  }
  disconnect() {
    clearTimeout(this.connectTimer)
    this.target.replaceChildren()
  }
  blur() {}
  sendKey() {}
}
