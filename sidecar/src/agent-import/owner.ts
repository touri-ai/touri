import type { Kernel } from "@touri/contracts"
import { deviceSession } from "../kernel/device-session"

export const isImportOwner = (kernel: Kernel, signal: AbortSignal): boolean => {
  if (signal.aborted) return false
  const session = deviceSession(signal)
  if (!session) return !kernel.services.use("work.authorizeHttp")
  if (!session.active() || session.automation || !session.person) return false

  return (
    session.person.role === "admin" &&
    session.person.id === (kernel.services.use("work.defaultPersonId")?.() ?? "owner")
  )
}
