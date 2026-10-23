import type { Message } from "@touri/contracts"
import type { RawMessage } from "./workspace-activity"

export const getMessageFromRow = (row: RawMessage): Message => {
  const parts = getRowJson(row.parts_json)

  return {
    seq: row.seq,
    generation: row.generation,
    updatedSeq: row.updated_seq,
    delivery: row.client_nonce
      ? { clientNonce: row.client_nonce, status: row.delivery_status ?? "queued", deadline: row.delivery_deadline ?? 0 }
      : null,
    id: row.id,
    threadId: row.thread_id,
    parentId: row.parent_id,
    role: row.role,
    kind: row.kind,
    status: row.status,
    runId: row.run_id,
    text: row.text,
    parts: Array.isArray(parts) ? parts : [],
    sender: getRowSender(row.sender_json),
    source: row.source === "legacy" ? "legacy" : "local",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const getRowJson = (value: string | null): unknown => {
  if (!value) return null

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const getRowSender = (value: string | null): Message["sender"] => {
  const sender = getRowJson(value)
  if (!sender || typeof sender !== "object" || !("name" in sender) || !("id" in sender)) return null
  if (typeof sender.name !== "string" || typeof sender.id !== "string") return null

  return {
    name: sender.name,
    id: sender.id,
    ...("avatarSeed" in sender && typeof sender.avatarSeed === "string" ? { avatarSeed: sender.avatarSeed } : {}),
    ...("kind" in sender && (sender.kind === "person" || sender.kind === "integration") ? { kind: sender.kind } : {}),
  }
}
