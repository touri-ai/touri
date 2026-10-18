import type { BotLearning, BotLearningSettings } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { SettingsSwitch } from "./SettingsLayout"

/** Per-bot switches for Hermes-style memory and skills. Both start off. */
export const LearningCard = ({ api, botId }: { api: UiApi; botId: string }) => {
  const [learning, setLearning] = useState<BotLearning | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let active = true
    setStatus("loading")
    void api
      .request("GET /bots/:id/learning", {}, { id: botId })
      .then((response) => {
        if (!active) return
        setLearning(response.learning)
        setStatus("ready")
      })
      .catch(() => {
        if (active) setStatus("error")
      })
    return () => {
      active = false
    }
  }, [api, botId])
  const save = async (patch: Partial<BotLearningSettings>) => {
    if (saving) return
    setSaving(true)
    try {
      const response = await api.request("PUT /bots/:id/learning", patch, { id: botId })
      setLearning(response.learning)
      setStatus("ready")
    } catch {
      setStatus("error")
    } finally {
      setSaving(false)
    }
  }
  return (
    <article className="screen-card learning-card" aria-labelledby={`learning-${botId}`}>
      <div className="screen-card-heading">
        <h3 id={`learning-${botId}`}>{t("Aprendizado contínuo")}</h3>
        <span className={`screen-status ${learning?.memory || learning?.skills ? "is-success" : ""}`}>
          {learning?.memory || learning?.skills ? t("Ativo") : t("Desligado")}
        </span>
      </div>
      <p>
        {t(
          "O bot guarda fatos que valem em toda conversa e registra procedimentos que se repetem como skills. As revisões automáticas rodam como turnos extras e usam a conta do provedor do bot.",
        )}
      </p>
      {status === "error" && (
        <p role="alert">{t("Não foi possível carregar ou salvar o aprendizado. Tente novamente.")}</p>
      )}
      {learning && (
        <div className="learning-switches">
          <label htmlFor={`learning-memory-${botId}`}>
            <SettingsSwitch
              id={`learning-memory-${botId}`}
              checked={learning.memory}
              disabled={saving}
              onChange={(event) => void save({ memory: event.target.checked })}
            />
            <span>
              <strong>{t("Memória automática")}</strong>
              <small>
                {t(
                  "A cada {count} conversas, revisa o que aprendeu sobre você e o ambiente. MEMORY.md: {memory} · USER.md: {user} caracteres.",
                  {
                    count: learning.memoryEveryTurns,
                    memory: learning.memoryChars,
                    user: learning.userChars,
                  },
                )}
              </small>
            </span>
          </label>
          <label htmlFor={`learning-skills-${botId}`}>
            <SettingsSwitch
              id={`learning-skills-${botId}`}
              checked={learning.skills}
              disabled={saving}
              onChange={(event) => void save({ skills: event.target.checked })}
            />
            <span>
              <strong>{t("Skills automáticas")}</strong>
              <small>
                {t(
                  "Depois de {count} chamadas de ferramenta, propõe skills novas ou correções. {skills} skills salvas.",
                  {
                    count: learning.skillsAfterToolCalls,
                    skills: learning.skillCount,
                  },
                )}
              </small>
            </span>
          </label>
        </div>
      )}
      <p className="screen-help">
        {t(
          "Fatos novos entram direto na memória. Mudanças em fatos existentes e qualquer skill proposta numa revisão pedem sua aprovação na conversa “Aprendizado contínuo”. Disponível para bots locais.",
        )}
      </p>
    </article>
  )
}
