/** Reuses the authenticated UI entry point; never puts a credential in the URL. */
export const openComputerWindow = async (botId: string): Promise<void> => {
  const url = new URL(window.location.href)
  url.search = ""
  url.searchParams.set("computer", botId)
  if ("__TAURI_INTERNALS__" in window) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
    const label = `computer-${botId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      await existing.setFocus()
      return
    }
    const viewer = new WebviewWindow(label, {
      url: `index.html${url.search}`,
      title: "touri · Computador do bot",
      width: 1100,
      height: 780,
      minWidth: 640,
      minHeight: 480,
      focus: true,
    })
    await new Promise<void>((resolve, reject) => {
      void viewer.once("tauri://created", () => resolve())
      void viewer.once("tauri://error", (event) =>
        reject(new Error(`Não foi possível abrir a janela: ${String(event.payload)}`)),
      )
    })
    // A window opened behind the main one is occluded and its webview reports itself hidden.
    await viewer.setFocus().catch(() => undefined)
    return
  }
  const viewer = window.open(url, "_blank", "popup,width=1100,height=780")
  if (!viewer) throw new Error("Permita a abertura de janelas para entrar no computador.")
  viewer.opener = null
}

export const closeComputerWindow = async (): Promise<void> => {
  const { getCurrentWindow, Window } = await import("@tauri-apps/api/window")
  const main = await Window.getByLabel("main")
  await main?.setFocus()
  await getCurrentWindow().close()
}
