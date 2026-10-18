export type HostKind = "mac" | "computer" | "server"

/** Headless hosts are servers; desktop hosts use their operating system's noun. */
export const getHostKind = (platform: string, headless = false): HostKind => {
  if (headless) return "server"
  if (platform === "darwin") return "mac"

  return "computer"
}

export const getHostNoun = (host: HostKind, locale: "pt-BR" | "en" = "pt-BR"): string => {
  if (host === "mac") return "Mac"
  if (host === "server") return locale === "pt-BR" ? "servidor" : "server"

  return locale === "pt-BR" ? "computador" : "computer"
}
