import { useEffect, useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { SettingsRow, SettingsSwitch } from "./SettingsLayout"

type Policy = {
  allowLan: boolean
  resolvers: string[]
  privateDomains: string[]
  restrictPublic?: boolean
  publicHosts?: string[]
}
type Status = { requested: Policy; active: Policy; providerHosts?: string[] }
const parseHosts = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((host) =>
        host
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/[/:].*$/, ""),
      )
      .filter(Boolean),
  ),
]
const pendingRestart = (status: Status): boolean => {
  const { requested, active } = status
  if (requested.allowLan && !active.allowLan) return true
  if (requested.resolvers.some((ip) => !active.resolvers.includes(ip))) return true
  if (active.privateDomains.some((domain) => !requested.privateDomains.includes(domain))) return true
  if (!active.restrictPublic) return false
  if (!requested.restrictPublic) return true
  return (requested.publicHosts ?? []).some((host) => !(active.publicHosts ?? []).includes(host))
}
export const BotNetworkSettings = ({ api, botId }: { api: UiApi; botId: string }) => {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [resolvers, setResolvers] = useState("")
  const [hosts, setHosts] = useState("")
  // VM-specific settings live outside bot/schema records and use the same authenticated client.
  const request = api.request as unknown as (
    route: string,
    body: unknown,
    params: Record<string, string>,
  ) => Promise<Status>
  useEffect(() => {
    let live = true
    void request("GET /bots/:id/network-policy", {}, { id: botId })
      .then((value) => {
        if (live) {
          setStatus(value)
          setResolvers(value.requested.resolvers.join(", "))
          setHosts((value.requested.publicHosts ?? []).join("\n"))
        }
      })
      .catch(() => {
        if (live) setError("Não foi possível ler a proteção de rede.")
      })
    return () => {
      live = false
    }
  }, [request, botId])
  const save = async (policy: Policy) => {
    setBusy(true)
    setError("")
    try {
      const next = await request("PUT /bots/:id/network-policy", policy, { id: botId })
      setStatus(next)
      setHosts((next.requested.publicHosts ?? []).join("\n"))
    } catch {
      setError("Não foi possível salvar a proteção de rede. Verifique a máquina.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Proteção de rede">
      <SettingsRow title="Permitir acesso à rede local" description={t("Rede local ajuda")}>
        <SettingsSwitch
          aria-label="Permitir acesso à rede local"
          checked={status?.requested.allowLan ?? false}
          disabled={!status || busy}
          onChange={(event) => {
            if (status) void save({ ...status.requested, allowLan: event.target.checked })
          }}
        />
      </SettingsRow>
      {status && (
        <label>
          Servidores DNS (IPs separados por vírgula)
          <input
            value={resolvers}
            disabled={busy}
            onChange={(event) => setResolvers(event.target.value)}
            onBlur={() => {
              const list = resolvers
                .split(",")
                .map((ip) => ip.trim())
                .filter(Boolean)
              if (list.join(",") !== status.requested.resolvers.join(","))
                void save({ ...status.requested, resolvers: list })
            }}
          />
        </label>
      )}
      <SettingsRow
        title="Limitar a internet a uma lista de sites"
        description="Desativado por padrão. Quando ativado, a máquina só acessa os sites desta lista e os serviços de que o provedor do bot precisa; todo o resto da internet fica bloqueado, inclusive consultas DNS. Um domínio libera também os seus subdomínios."
      >
        <SettingsSwitch
          aria-label="Limitar a internet a uma lista de sites"
          checked={status?.requested.restrictPublic ?? false}
          disabled={!status || busy}
          onChange={(event) => {
            if (status)
              void save({ ...status.requested, restrictPublic: event.target.checked, publicHosts: parseHosts(hosts) })
          }}
        />
      </SettingsRow>
      {status?.requested.restrictPublic && (
        <>
          <label>
            Sites permitidos (um por linha)
            <textarea
              value={hosts}
              rows={4}
              disabled={busy}
              placeholder={"github.com\nregistry.npmjs.org"}
              onChange={(event) => setHosts(event.target.value)}
              onBlur={() => {
                const list = parseHosts(hosts)
                if (list.join(",") !== (status.requested.publicHosts ?? []).join(","))
                  void save({ ...status.requested, publicHosts: list })
              }}
            />
          </label>
          {status.providerHosts && status.providerHosts.length > 0 && (
            <p className="muted">Sempre liberados para o provedor deste bot: {status.providerHosts.join(", ")}.</p>
          )}
        </>
      )}
      <p className="muted">Consultas a nomes locais e privados são bloqueadas antes de sair da máquina.</p>
      <p className="muted">
        Máquinas criadas em versões anteriores também começam com a rede local bloqueada. Se este bot acessa servidores
        da sua rede, ative a opção acima, reinicie a máquina e use o endereço IP do servidor em vez de nomes como .local
        ou .lan.
      </p>
      {status && pendingRestart(status) && (
        <p role="status">Reinicie a máquina para aplicar as permissões adicionais de rede.</p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
