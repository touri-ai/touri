import { isIP } from "node:net"

export type AddressReachability = "public" | "private" | "localhost" | "tailnet" | "invalid" | "unset"

const isPrivateIpv4 = (address: string): boolean => {
  const parts = address.split(".").map(Number)
  const first = parts[0] ?? 0
  const second = parts[1] ?? 0
  const third = parts[2] ?? 0
  if (first === 0 || first === 10 || first === 127 || first >= 224) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && (second === 0 || second === 2 || second === 88 || second === 168)) return true
  if (first === 198 && (second === 18 || second === 19 || second === 51)) return true
  return first === 203 && second === 0 && third === 113
}

const getAddressHost = (address: string): string => {
  try {
    return new URL(address).hostname.toLowerCase().replace(/^\[|\]$/gu, "")
  } catch {
    return ""
  }
}

const isPrivateIpv6 = (host: string): boolean => {
  const normalized = host.toLowerCase()
  if (normalized === "::" || normalized === "::1") return true
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true
  if (/^fe[89ab]/u.test(normalized)) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1]
  if (mapped) return isPrivateIpv4(mapped)
  if (normalized.startsWith("2001:db8:")) return true
  const firstGroup = Number.parseInt(normalized.split(":")[0] ?? "", 16)
  return !Number.isInteger(firstGroup) || firstGroup < 0x2000 || firstGroup > 0x3fff
}

export const getAddressReachability = (address: string | null | undefined): AddressReachability => {
  if (!address) return "unset"
  const host = getAddressHost(address)
  if (!host) return "invalid"
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost"
  if (host.endsWith(".ts.net")) return "tailnet"
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return "private"
  if (isIP(host) === 4) return isPrivateIpv4(host) ? "private" : "public"
  if (isIP(host) === 6) return isPrivateIpv6(host) ? "private" : "public"
  return "public"
}

export const parsePublicAddress = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const input = value.trim()
  if (!input || input.length > 2048) return input ? null : ""
  let address: URL
  try {
    address = new URL(input)
  } catch {
    return null
  }
  if (
    address.protocol !== "https:" ||
    !address.hostname ||
    address.username ||
    address.password ||
    address.pathname !== "/" ||
    address.search ||
    address.hash
  )
    return null
  return address.origin
}
