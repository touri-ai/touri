/**
 * Compiled binaries embed the runtime of the Bun that built them, so release builds must use the pinned
 * toolchain. Older runtimes can abort the headless server before it prints anything.
 */
export const pinnedBunVersion = "1.4.3"

export const getBunToolchainError = (version: string, pinned = pinnedBunVersion): string | undefined => {
  if (version === pinned) return undefined
  return `Bun ${version} cannot build touri binaries; install Bun ${pinned} (the version CI and releases use) and retry.`
}

export const assertBunToolchain = (version = Bun.version): void => {
  const error = getBunToolchainError(version)
  if (error) throw new Error(error)
}
