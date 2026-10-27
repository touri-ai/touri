import type { Database } from "bun:sqlite"
import type { VmProvider } from "./types"

export type MachineMetadata = {
  bot_id: string
  vm_id: string
  volume: string
  project_id: string | null
  folder_fingerprint: string
  created_ms: number | null
  start_ms: number | null
}

type Upgrade = { previous: MachineMetadata; candidate: string; committed: boolean }

// Keep the original container until readiness, network policy and connection setup succeed.
// The journal also makes an interrupted replacement recoverable after a sidecar restart.
export const createMachineUpgrades = (
  db: Database,
  provider: VmProvider,
  now: () => number,
  removeKey: (id: string) => Promise<void>,
) => {
  const getPending = (botId: string): Upgrade | null => {
    const row = db.query("SELECT value_json FROM settings WHERE key = ?").get(`vm-upgrade:${botId}`) as {
      value_json: string
    } | null

    return row ? (JSON.parse(row.value_json) as Upgrade) : null
  }
  const save = (botId: string, upgrade: Upgrade) => {
    db.query("INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)").run(
      `vm-upgrade:${botId}`,
      JSON.stringify(upgrade),
      now(),
    )
  }
  const clear = (botId: string) => db.query("DELETE FROM settings WHERE key = ?").run(`vm-upgrade:${botId}`)
  const check = (result: { success: boolean }) => {
    if (!result.success) throw new Error("Não foi possível recuperar o computador anterior. Tente ligar novamente.")
  }
  const remove = async (id: string) => {
    const status = await provider.status({ id, signal: AbortSignal.timeout(10_000) })
    check(status)
    if (!status.success) return
    if (status.status === "running") check(await provider.stop({ id }))
    if (status.status !== "missing") check(await provider.destroy({ id }))
    await removeKey(id)
  }
  const rollback = async (botId: string, upgrade: Upgrade) => {
    // Never start both containers with the same writable volumes.
    await remove(upgrade.candidate)
    const previous = upgrade.previous
    db.transaction(() => {
      db.query(
        "UPDATE bot_machines SET vm_id = ?, volume = ?, folder_fingerprint = ?, project_id = ? WHERE bot_id = ?",
      ).run(previous.vm_id, previous.volume, previous.folder_fingerprint, previous.project_id, botId)
      clear(botId)
    })()
  }
  const finish = async (botId: string, upgrade: Upgrade) => {
    save(botId, { ...upgrade, committed: true })
    await remove(upgrade.previous.vm_id)
    clear(botId)
  }

  return {
    getPending,
    begin: (previous: MachineMetadata, candidate: MachineMetadata) => {
      const upgrade = { previous, candidate: candidate.vm_id, committed: false }
      db.transaction(() => {
        save(previous.bot_id, upgrade)
        db.query("UPDATE bot_machines SET vm_id = ?, volume = ? WHERE bot_id = ?").run(
          candidate.vm_id,
          candidate.volume,
          previous.bot_id,
        )
      })()

      return upgrade
    },
    rollback,
    finish,
  }
}
