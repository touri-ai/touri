import { realpathSync } from "node:fs"

export type DarwinSandboxProfileArgs = { roots: string[] }

const DEVICE_SINKS: readonly string[] = [
  "/dev/null",
  "/dev/zero",
  "/dev/tty",
  "/dev/dtracehelper",
  "/dev/stdout",
  "/dev/stderr",
]

const canonical = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Seatbelt profile for local workspace-write processes: writes are confined to the
 * given roots. Standard device sinks stay writable, otherwise any `> /dev/null`
 * redirect in a project command fails with "Operation not permitted".
 */
export const darwinSandboxProfile = ({ roots }: DarwinSandboxProfileArgs): string => {
  const allowed = [
    ...[...new Set(roots.flatMap((root) => [root, canonical(root)]))].map(
      (root) => `(subpath ${JSON.stringify(root)})`,
    ),
    ...DEVICE_SINKS.map((device) => `(literal ${JSON.stringify(device)})`),
    '(subpath "/dev/fd")',
  ]

  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${allowed.join(" ")})`
}
