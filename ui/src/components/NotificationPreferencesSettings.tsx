import {
  type Bot,
  NOTIFICATION_KINDS,
  type NotificationPreferences,
  type NotificationScopePreferences,
  type NotifyKind,
} from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../api/client"
import { type TranslationKey, t } from "../i18n"
import { SettingsSwitch } from "./SettingsLayout"
import "./notification-delivery.css"

export const NotificationPreferencesSettings = ({
  value,
  onChange,
  api,
}: {
  value: NotificationPreferences
  onChange: (preferences: NotificationPreferences) => void
  api?: UiApi | undefined
}) => {
  const [bots, setBots] = useState<Bot[]>([])
  const [scopeId, setScopeId] = useState("")
  const [loadError, setLoadError] = useState(false)
  useEffect(() => {
    if (!api) return

    let active = true
    void api.request("GET /bots", {}).then(
      ({ bots }) => {
        if (active) setBots(bots)
      },
      () => {
        if (active) setLoadError(true)
      },
    )
    return () => {
      active = false
    }
  }, [api])

  const scope = scopeId ? (value.bots?.[scopeId] ?? {}) : value
  const saveScope = (patch: NotificationScopePreferences) => {
    const next = { ...scope, ...patch }
    if (!scopeId) {
      onChange({ ...value, ...patch })
      return
    }

    onChange({ ...value, bots: { ...value.bots, [scopeId]: next } })
  }
  const saveDigest = (digest: string) => {
    if (digest === "attention" || digest === "all") {
      saveScope({ digest })
      return
    }

    const { digest: _digest, ...inherited } = scope
    if (!scopeId) {
      onChange(inherited)
      return
    }

    onChange({ ...value, bots: { ...value.bots, [scopeId]: inherited } })
  }
  const saveType = (kind: NotifyKind, selected: string) => {
    const { [kind]: _override, ...inherited } = scope.types ?? {}
    const types = selected === "inherit" ? inherited : { ...inherited, [kind]: selected === "on" }
    saveScope({ types })
  }
  const quiet = value.quietHours ?? { enabled: false, start: "22:00", end: "08:00" }
  const saveQuiet = (patch: Partial<NonNullable<NotificationPreferences["quietHours"]>>) =>
    onChange({ ...value, quietHours: { ...quiet, ...patch } })

  return (
    <div className="notification-preferences">
      <label className="notification-preference-row">
        <span>{t("Aplicar a")}</span>
        <select aria-label={t("Aplicar a")} value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
          <option value="">{t("Todos os bots")}</option>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      {loadError && <p role="alert">{t("Não foi possível carregar os bots. Reabra as preferências.")}</p>}
      {scopeId && (
        <label className="notification-preference-row">
          <span>{t("Receber avisos deste bot")}</span>
          <SettingsSwitch
            checked={scope.enabled !== false}
            onChange={(event) => saveScope({ enabled: event.target.checked })}
          />
        </label>
      )}
      <label className="notification-preference-row">
        <span>{t("Avisar sobre")}</span>
        <select
          aria-label={t("Avisar sobre")}
          value={scope.digest ?? "inherit"}
          onChange={(event) => saveDigest(event.target.value)}
        >
          <option value="inherit">{t("Usar padrão")}</option>
          <option value="attention">{t("Somente o que precisa de mim")}</option>
          <option value="all">{t("Também resultados concluídos")}</option>
        </select>
      </label>
      <fieldset>
        <legend>{t("Tipos de aviso")}</legend>
        {NOTIFICATION_KINDS.map((kind) => (
          <label className="notification-preference-row" key={kind}>
            <span>{t(KIND_LABELS[kind])}</span>
            <select
              aria-label={t(KIND_LABELS[kind])}
              value={getTypeValue(scope, kind)}
              onChange={(event) => saveType(kind, event.target.value)}
            >
              <option value="inherit">{t("Usar padrão")}</option>
              <option value="on">{t("Avisar")}</option>
              <option value="off">{t("Silenciar")}</option>
            </select>
          </label>
        ))}
      </fieldset>
      <p>
        {t(
          scopeId
            ? "Usar padrão herda os filtros globais e a preferência atual do bot."
            : "Usar padrão mantém a preferência atual de cada bot.",
        )}
      </p>
      <fieldset>
        <legend>{t("Horário silencioso")}</legend>
        <label className="notification-preference-row">
          <span>{t("Ativar horário silencioso")}</span>
          <SettingsSwitch checked={quiet.enabled} onChange={(event) => saveQuiet({ enabled: event.target.checked })} />
        </label>
        {quiet.enabled && (
          <div className="notification-quiet-times">
            <label>
              {t("Das")}
              <input
                type="time"
                required
                value={quiet.start}
                onChange={(event) => {
                  if (event.target.value) saveQuiet({ start: event.target.value })
                }}
              />
            </label>
            <label>
              {t("Até")}
              <input
                type="time"
                required
                value={quiet.end}
                onChange={(event) => {
                  if (event.target.value) saveQuiet({ end: event.target.value })
                }}
              />
            </label>
          </div>
        )}
        <p>
          {t(
            "Vale para todos os bots, no horário local do computador que executa o touri. Os avisos ficam guardados e contados, sem alertas nem som. Horários iguais silenciam o dia todo.",
          )}
        </p>
      </fieldset>
      <p>{t("Os filtros controlam os alertas. Todos os avisos continuam na central de notificações.")}</p>
    </div>
  )
}

const KIND_LABELS: Record<NotifyKind, TranslationKey> = {
  approval: "Approval",
  question: "Question",
  takeover: "Needs you",
  "turn-failed": "Turn failed",
  "routine-failed": "Routine failed",
  "routine-deferred": "Routine skipped",
  "delegation-settled": "Delegation",
  incident: "Incident",
  done: "Done",
}

const getTypeValue = (scope: NotificationScopePreferences, kind: NotifyKind): string => {
  if (scope.types?.[kind] === undefined) return "inherit"

  return scope.types[kind] ? "on" : "off"
}
