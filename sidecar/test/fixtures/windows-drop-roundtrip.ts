import assert from "node:assert/strict"
import { rename, writeFile } from "node:fs/promises"
import { createHostClient } from "../../src/kernel/host-client"
import { redeemFileGrant } from "../../src/store/redeemFileGrant"

const [socketPath, token, validId, changedId] = process.argv.slice(2)
assert(socketPath && token && validId && changedId)
const client = createHostClient({ socketPath, token, onNotification: () => {} })
const signal = AbortSignal.timeout(20_000)
try {
  const first = await redeemFileGrant({ kernel: client, grantId: validId, signal })
  assert.equal(first.success, true)
  if (!first.success) throw new Error("Missing attachment bytes")
  assert.equal(first.content.byteLength, 15 * 1024 * 1024)
  assert.equal(first.content[0], 65)
  assert.equal(first.content.at(-1), 65)
  const replay = await redeemFileGrant({ kernel: client, grantId: validId, signal })
  assert.equal(replay.success, false)
  const kernel = {
    callHost: (async (method, params) => {
      const result = await client.callHost(method, params)
      if (method === "file.grant.redeem" && result.success) {
        const value = result.value as { path: string }
        await rename(value.path, `${value.path}.original`)
        await writeFile(value.path, "replacement")
      }
      return result
    }) as typeof client.callHost,
  }
  const swapped = await redeemFileGrant({ kernel, grantId: changedId, signal })
  assert.equal(swapped.success, false)
} finally {
  client.close()
}
