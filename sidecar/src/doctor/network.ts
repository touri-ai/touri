import { lookup } from "node:dns/promises"
import { connect } from "node:tls"
import type { DoctorCheck } from "@touri/contracts"
import { hostPlatform } from "../platform"
import { check } from "./check"

export const providerTargets = [
  { id: "anthropic", label: "Anthropic", host: "api.anthropic.com", path: "/v1/models" },
  { id: "openai", label: "OpenAI", host: "api.openai.com", path: "/v1/models" },
  { id: "openrouter", label: "OpenRouter", host: "openrouter.ai", path: "/api/v1/models" },
] as const

export type NetworkProbes = {
  dns: (host: string, signal: AbortSignal) => Promise<void>
  tls: (host: string, signal: AbortSignal) => Promise<void>
  http: (url: string, signal: AbortSignal) => Promise<number>
}

export const networkProbes: NetworkProbes = {
  dns: async (host) => {
    await lookup(host)
  },
  tls: (host, signal) =>
    new Promise<void>((resolve, reject) => {
      const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: true })
      const cleanup = () => {
        signal.removeEventListener("abort", cancel)
        socket.destroy()
      }
      const cancel = () => {
        cleanup()
        reject(signal.reason)
      }
      socket.once("error", (error: Error) => {
        cleanup()
        reject(error)
      })
      socket.once("secureConnect", () => {
        cleanup()
        resolve()
      })
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
    }),
  http: async (url, signal) => {
    // Fixed public endpoints, no credentials, no request body and no redirects.
    const response = await fetch(url, { method: "GET", signal, redirect: "manual", credentials: "omit" })
    await response.body?.cancel()
    return response.status
  },
}

export const withinDeadline = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<T> => {
  parent.throwIfAborted()
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new DOMException("Probe timed out", "TimeoutError")), timeoutMs)
  const signal = AbortSignal.any([parent, deadline.signal])
  let cancel: () => void = () => undefined
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener("abort", cancel, { once: true })
  })
  try {
    return await Promise.race([operation(signal), interrupted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", cancel)
  }
}

export const collectNetworkChecks = async (
  signal: AbortSignal,
  probes: NetworkProbes = networkProbes,
  timeoutMs = 4000,
): Promise<Array<DoctorCheck>> =>
  (
    await Promise.all(
      providerTargets.map(async (target) => {
        const results: Array<DoctorCheck> = []
        const url = `https://${target.host}${target.path}`
        for (const stage of ["dns", "tls", "http"] as const) {
          signal.throwIfAborted()
          const label = `${target.label} · ${stage === "http" ? "conexão" : stage.toUpperCase()}`
          const started = Date.now()
          let result: DoctorCheck
          try {
            const status = await withinDeadline<unknown>(
              (probeSignal) =>
                stage === "http" ? probes.http(url, probeSignal) : probes[stage](target.host, probeSignal),
              signal,
              timeoutMs,
            )
            if (stage === "http") {
              const reachable = typeof status === "number" && ((status >= 200 && status < 300) || status === 401)
              result = check(
                `network-${target.id}-${stage}`,
                label,
                reachable ? "pass" : status === 429 || status === 403 ? "warn" : "fail",
                reachable
                  ? `API respondeu (HTTP ${status}). ${status === 401 ? "Autenticação exigida, como esperado para esta sondagem sem credenciais." : "Nenhum conteúdo ou credencial foi enviado."}`
                  : `API respondeu com HTTP ${status}. Verifique bloqueios de rede, proxy ou indisponibilidade do provedor.`,
                `curl --head --connect-timeout 5 '${url}'`,
              )
            } else {
              result = check(
                `network-${target.id}-${stage}`,
                label,
                "pass",
                stage === "dns"
                  ? `${target.host} resolvido pelo DNS do sistema.`
                  : `Certificado de ${target.host} validado; conexão TLS segura.`,
              )
            }
          } catch {
            signal.throwIfAborted()
            result = check(
              `network-${target.id}-${stage}`,
              label,
              "fail",
              stage === "dns"
                ? `Não foi possível resolver ${target.host}. Verifique sua conexão e a configuração de DNS.`
                : stage === "tls"
                  ? `Falha ao validar TLS de ${target.host}. Verifique a data do sistema, certificados e proxy da rede.`
                  : `Sem resposta da API em até ${timeoutMs / 1000}s. Verifique conexão, VPN, firewall e proxy.`,
              stage === "dns"
                ? hostPlatform.systemSettingsCommand
                : stage === "tls"
                  ? `curl --verbose --head --connect-timeout 5 '${url}'`
                  : `curl --head --connect-timeout 5 '${url}'`,
            )
          }
          results.push({ ...result, durationMs: Date.now() - started })
        }
        return results
      }),
    )
  ).flat()
