import { getHostKind } from "@touri/contracts"

export const getHost = (platform = process.platform, headless = process.env.TOURI_HEADLESS === "1") =>
  getHostKind(platform, headless)
