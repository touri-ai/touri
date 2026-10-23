/** The native webview reports the host OS. Unknown test environments preserve the existing UI. */
export const supportsHostComputer = (userAgent: string, native = true) =>
  native && !/Linux|Windows|Android/i.test(userAgent)
export const hostComputerSupported = supportsHostComputer(
  globalThis.navigator?.userAgent ?? "",
  "__TAURI_INTERNALS__" in globalThis,
)
export const pathLeaf = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? path
