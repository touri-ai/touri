import { expect, test } from "bun:test"
import { authenticatedSender, bindDeviceSession, withAuthenticatedSender } from "../../src/kernel/device-session"

test("channel sender metadata comes only from the authenticated person", () => {
  const signal = new AbortController().signal
  bindDeviceSession(signal, {
    deviceId: "device-a",
    person: {
      id: "person-a",
      name: "Ana",
      email: "ana@example.test",
      avatarSeed: "seed-a",
      role: "member",
    },
    active: () => true,
  })
  expect(authenticatedSender(signal)).toEqual({ id: "person-a", name: "Ana", avatarSeed: "seed-a", kind: "person" })
  expect(
    withAuthenticatedSender(signal, {
      threadId: "thread-a",
      parentId: null,
      text: "Olá",
      attachmentIds: [],
      sender: { id: "owner", name: "Owner", avatarSeed: "forged" },
    }).sender,
  ).toEqual({ id: "person-a", name: "Ana", avatarSeed: "seed-a", kind: "person" })
  expect(
    withAuthenticatedSender(new AbortController().signal, {
      threadId: "thread-a",
      parentId: null,
      text: "Olá",
      attachmentIds: [],
      sender: { id: "owner", name: "Owner", avatarSeed: "forged" },
    }),
  ).not.toHaveProperty("sender")
  expect(authenticatedSender(new AbortController().signal)).toBeNull()
})
