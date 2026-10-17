import { existsSync } from "node:fs"
import { darwinSandboxProfile } from "./macos/sandbox"

export const projectSandboxCommand = ({
  roots,
  shell,
  command,
}: {
  roots: string[]
  shell: string
  command: string
}): { cmd: string; args: string[] } | null => {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
    return { cmd: "/usr/bin/sandbox-exec", args: ["-p", darwinSandboxProfile({ roots }), shell, "-c", command] }
  const binary = process.platform === "linux" ? Bun.which("bwrap", { PATH: "/usr/bin:/bin" }) : null
  return binary
    ? {
        cmd: binary,
        args: [
          "--die-with-parent",
          "--unshare-pid",
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          ...roots.filter(existsSync).flatMap((root) => ["--bind", root, root]),
          "--",
          shell,
          "-c",
          command,
        ],
      }
    : null
}
