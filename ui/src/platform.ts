/** The native webview reports the host OS. Unknown test environments preserve the existing UI. */
export const supportsHostComputer = (userAgent: string) => !/Linux|Windows|Android/i.test(userAgent)
export const hostComputerSupported = supportsHostComputer(globalThis.navigator?.userAgent ?? "")
export const pathLeaf = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? path
