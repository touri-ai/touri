/** Holds one incremental request; a full refresh must survive coalescing and hiding. */
export class DesktopFrames {
  private pending: Buffer | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastAt = -Infinity
  private visible = true

  constructor(
    private readonly interval: number,
    private readonly send: (packet: Buffer) => void,
    private readonly now = () => performance.now(),
  ) {}

  request(packet: Buffer) {
    const full = this.pending?.[1] === 0 || packet[1] === 0
    this.pending = Buffer.from(packet)
    if (full) this.pending[1] = 0
    this.schedule()
  }

  setVisible(visible: boolean) {
    this.visible = visible
    clearTimeout(this.timer)
    this.timer = undefined
    if (visible) this.schedule()
  }

  dispose() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
  }

  private schedule() {
    if (!this.visible || !this.pending || this.timer) return
    const delay = Math.max(0, this.interval - (this.now() - this.lastAt))
    if (!delay) return this.flush()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delay)
  }

  private flush() {
    const packet = this.pending
    this.pending = undefined
    if (!packet || !this.visible) return
    this.lastAt = this.now()
    this.send(packet)
  }
}
