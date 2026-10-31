import { expect, test } from "bun:test"
import type { Kernel } from "@touri/contracts"
import { bindDeviceSession, type DeviceSession } from "../../src/kernel/device-session"
import { redeemFileGrant } from "../../src/store/redeemFileGrant"

test.each([
  { native: true, active: true, expectedCalls: 1 },
  { native: false, active: true, expectedCalls: 0 },
  { native: true, active: false, expectedCalls: 0 },
])("only an active native session can redeem a desktop drop grant: $native/$active", async (input) => {
  const signal = new AbortController().signal
  const session: DeviceSession = {
    deviceId: "synthetic-desktop",
    active: () => input.active,
    ...(input.native ? { native: true } : {}),
  }
  bindDeviceSession(signal, session)
  const calls: string[] = []
  const kernel: Pick<Kernel, "callHost"> = {
    callHost: async () => {
      calls.push("redeem")
      return { success: false, errorCode: "HOST_ERROR", error: "Synthetic unissued grant" }
    },
  }

  const result = await redeemFileGrant({ kernel, grantId: "a".repeat(64), signal })

  expect(calls).toHaveLength(input.expectedCalls)
  expect(result).toMatchObject({ success: false, status: 403 })
})
