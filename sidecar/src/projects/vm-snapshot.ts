import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Kernel, VmRuntime } from "@touri/contracts"
import type { VmProvider } from "../vm/types"
import { inspectGit, runCommand } from "./git"

// A bundle copies only Git objects, never the host's config, credentials, untracked
// files or working-tree edits. The guest gets an independent checkout of HEAD.
export const copyProjectSnapshot = async ({
  kernel,
  provider,
  vmId,
  botId,
  projectPath,
  exec,
  signal,
}: {
  kernel: Kernel
  provider: VmProvider
  vmId: string
  botId: string
  projectPath: string
  exec: VmRuntime["exec"]
  signal: AbortSignal
}) => {
  const git = await inspectGit({ kernel, projectPath, signal })
  signal.throwIfAborted()
  if (!git?.commit)
    throw new Error("O projeto precisa de um commit Git. Crie um commit na pasta de origem e tente novamente.")
  const scratch = await mkdtemp(join(kernel.paths.runDir, "project-snapshot-"))
  const bundle = join(scratch, "source.bundle")
  const guestBundle = `/tmp/touri-project-${kernel.newId()}.bundle`
  const guestGit = async (args: string[]) => {
    const result = await exec({ botId, command: "git", args, signal })
    if (!result.success || result.code !== 0)
      throw new Error(
        "Não foi possível preparar o commit na VM. Confira se /workspace contém arquivos em conflito; depois tente novamente.",
      )
  }
  try {
    const built = await runCommand({
      kernel,
      cmd: "git",
      args: ["bundle", "create", bundle, "HEAD"],
      cwd: projectPath,
      signal,
    })
    if (!built.success || built.output.code !== 0)
      throw new Error("Não foi possível copiar o commit Git. Confira o acesso à pasta de origem e tente novamente.")
    signal.throwIfAborted()
    const transfer = provider.spawn({
      id: vmId,
      command: "/bin/sh",
      args: ["-c", 'cat > "$1"', "touri", guestBundle],
      cwd: "/workspace",
      user: "1000",
    })
    if (!transfer.success) throw new Error("Não foi possível enviar o projeto à VM. Tente novamente.")
    const cancel = () => transfer.kill("SIGKILL")
    signal.addEventListener("abort", cancel, { once: true })
    try {
      signal.throwIfAborted()
      await Promise.all([
        Bun.file(bundle).stream().pipeTo(transfer.stdin, { signal }),
        new Response(transfer.stdout).text(),
        new Response(transfer.stderr).text(),
      ])
      if ((await transfer.exited).code !== 0)
        throw new Error("A transferência do projeto à VM falhou. Tente novamente.")
    } finally {
      signal.removeEventListener("abort", cancel)
    }
    await guestGit(["init"])
    await guestGit(["fetch", "--no-tags", guestBundle, "HEAD"])
    await guestGit(["checkout", "--detach", git.commit])
    if (git.remote) await guestGit(["config", "remote.origin.url", git.remote])
    return { commit: git.commit, remote: git.remote, branch: git.branch, path: projectPath }
  } finally {
    await rm(scratch, { recursive: true, force: true })
    // The path belongs to this transfer; cleanup cannot touch other guest files.
    await exec({ botId, command: "rm", args: ["-f", guestBundle], signal: AbortSignal.timeout(2000) }).catch(() => {})
  }
}
