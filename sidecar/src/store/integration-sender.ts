import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import type { ChannelPerson, Kernel, MessageSender } from "@touri/contracts"
import { deviceSession } from "../kernel/device-session"

type SenderResult =
  | { success: true; sender: MessageSender }
  | { success: false; status: 400 | 403; errorCode: string; error: string }

export const getIntegrationSender = (
  signal: AbortSignal,
  input: unknown,
  kernel: Kernel,
  groupId: string | null,
): SenderResult => {
  const session = deviceSession(signal)
  if (!session?.active() || session.person?.role !== "admin" || !session.scopes?.includes("integration:write"))
    return { success: false, status: 403, errorCode: "FORBIDDEN", error: "Integration write scope required" }
  if (!input || typeof input !== "object" || Array.isArray(input)) return getInvalidSender()

  const requested = input as Record<string, unknown>
  if (requested.kind !== "integration" || Object.keys(requested).some((key) => !["kind", "name"].includes(key)))
    return getInvalidSender()

  const name = requested.name === undefined ? session.clientName : requested.name
  if (typeof name !== "string" || name.length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name))
    return getInvalidSender()

  const displayName = name.trim().normalize("NFKC")
  const normalized = getNormalizedName(displayName)
  const identities = groupId ? getChannelIdentities(kernel, groupId) : []
  const reserved = [
    "owner",
    "you",
    "você",
    ...identities.flatMap((identity) => [identity.name, identity.handle ?? identity.name]),
  ]
  if (reserved.some((value) => getNormalizedName(value) === normalized)) return getInvalidSender()

  const digest = createHash("sha256").update(`${session.deviceId}\0${normalized}`).digest("hex")
  const id = `integration:${digest}`
  return { success: true, sender: { id, name: displayName, avatarSeed: id, kind: "integration" } }
}

const getChannelIdentities = (kernel: Kernel, groupId: string): Pick<ChannelPerson, "name" | "handle">[] => {
  const people = kernel.services.use("work.channelPeople")?.(groupId) ?? []
  const bots = (kernel.db as Database)
    .query("SELECT b.name FROM group_members gm JOIN bots b ON b.id = gm.bot_id WHERE gm.group_id = ?")
    .all(groupId) as Array<{ name: string }>
  return [...people, ...bots.map(({ name }) => ({ name, handle: name }))]
}

const getNormalizedName = (value: string): string =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim()

const getInvalidSender = (): SenderResult => ({
  success: false,
  status: 400,
  errorCode: "INVALID_INTEGRATION",
  error: "Use a distinct integration name of 1 to 80 letters, numbers, spaces, dots, underscores or hyphens",
})
