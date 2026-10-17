import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { DoctorCheck } from "@touri/contracts"
import { check } from "./check"

/** Metadata only, on demand; never read transcripts or follow links into other trees. */
export const codexSessionsCheck = async (hostHome: string, signal?: AbortSignal): Promise<DoctorCheck> => {
  let bytes = 0
  let files = 0
  const pending = [join(hostHome, ".codex/sessions")]
  let measured = true
  try {
    while (pending.length) {
      signal?.throwIfAborted()
      const path = pending.pop()
      if (!path) break
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      })
      if (stat?.isFile()) {
        bytes += stat.size
        files++
      } else if (stat?.isDirectory()) {
        for (const entry of await readdir(path)) pending.push(join(path, entry))
      }
    }
  } catch {
    signal?.throwIfAborted()
    measured = false
  }
  const large = bytes >= 100 * 1024 ** 2 || files >= 10_000
  return check(
    "codex-sessions",
    "Codex · histórico do host",
    "pass",
    [
      measured
        ? `Histórico ${large ? "grande " : ""}em ~/.codex/sessions: ${(bytes / 1024 ** 2).toFixed(1)} MiB; ${files} arquivos.`
        : "Não foi possível medir o histórico em ~/.codex/sessions.",
      "Bots locais com login do host usam CODEX_HOME isolado por bot e compartilham apenas o login; não varrem esse histórico ao iniciar.",
    ].join(" "),
  )
}
