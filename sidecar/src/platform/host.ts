import { getHostKind } from "@touri/contracts"

export const getHost = (platform = process.platform, headless = process.env.TOURI_HEADLESS === "1") =>
  getHostKind(platform, headless)

/** Preserve the original wire values for older clients while reporting desktop computers accurately. */
export const getHostIdentity = (platform = process.platform, headless = process.env.TOURI_HEADLESS === "1") => {
  const hostKind = getHost(platform, headless)
  const host: "mac" | "server" = hostKind === "mac" ? "mac" : "server"

  return { host, hostKind }
}
