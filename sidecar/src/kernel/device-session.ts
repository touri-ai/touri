import { AsyncLocalStorage } from "node:async_hooks"
import type { SendMessageInput } from "@touri/contracts"

/** Authentication metadata stays out of route bodies and query strings. */
export type DevicePerson = {
  id: string
  name: string
  email: string | null
  avatarSeed: string
  role: "member" | "admin"
}
export type DeviceSession = { deviceId: string; active: () => boolean; person?: DevicePerson; origin?: string }
const sessions = new WeakMap<AbortSignal, DeviceSession>()
export const socketDeviceContext = new AsyncLocalStorage<DeviceSession | undefined>()
export const bindDeviceSession = (signal: AbortSignal, session: DeviceSession): void => {
  sessions.set(signal, session)
}
export const deviceSession = (signal: AbortSignal): DeviceSession | undefined => sessions.get(signal)
export const authenticatedSender = (
  signal: AbortSignal,
): { id: string; name: string; avatarSeed: string; kind: "person" } | null => {
  const person = deviceSession(signal)?.person
  return person ? { id: person.id, name: person.name, avatarSeed: person.avatarSeed, kind: "person" } : null
}
export const withAuthenticatedSender = (signal: AbortSignal, input: SendMessageInput): SendMessageInput => {
  const { sender: _ignored, ...message } = input
  const sender = authenticatedSender(signal)
  return sender ? { ...message, sender } : message
}
