import protocol from "../protocol.json"

/** Change only when the HTTP/event contract becomes incompatible, independently of storage migrations. */
export const SERVER_PROTOCOL_VERSION = protocol.version

export const isServerProtocolCompatible = (health: { protocolVersion?: number; schemaVersion: number }): boolean => {
  if (health.protocolVersion !== undefined) return health.protocolVersion === SERVER_PROTOCOL_VERSION

  // Older servers did not advertise a protocol. Keep the last known storage contract as a safe fallback.
  return health.schemaVersion === protocol.legacySchemaVersion
}
