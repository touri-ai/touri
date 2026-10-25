import { isServerProtocolCompatible, SERVER_PROTOCOL_VERSION } from "@touri/contracts"
import { expect, test } from "vitest"

test.each([
  [{ version: "99.0.0", schemaVersion: 99, protocolVersion: SERVER_PROTOCOL_VERSION }, true],
  [{ schemaVersion: 46 }, true],
  [{ schemaVersion: 47 }, false],
  [{ schemaVersion: 46, protocolVersion: 1 }, false],
])("compatibility follows the wire protocol: %j", (health, expected) => {
  expect(isServerProtocolCompatible(health)).toBe(expected)
})
