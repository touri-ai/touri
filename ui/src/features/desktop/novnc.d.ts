declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: string | WebSocket, options?: { shared?: boolean })
    qualityLevel: number
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    dragViewport: boolean
    resizeSession: boolean
    focusOnClick: boolean
    disconnect(): void
    blur(): void
    getImageData(): ImageData
    sendKey(keysym: number, code: string | null, down?: boolean): void
  }
}
