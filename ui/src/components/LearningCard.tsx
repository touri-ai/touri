import type { BotLearning, BotLearningSettings } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { SettingsSwitch } from "./SettingsLayout"

/** Per-bot switches for memory and skills. Both start off. */
export const LearningCard = ({ api, botId }: { api: UiApi; botId: string }) => {
  const [attempt, setAttempt] = useState(0)
  return (
    <LearningSettings
      key={`${botId}:${attempt}`}
      api={api}
      botId={botId}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  )
}

const LearningSettings = ({ api, botId, onRetry }: { api: UiApi; botId: string; onRetry: () => void }) => {
  const [learning, setLearning] = useState<BotLearning | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const busy = useRef(false)
  useEffect(() => {
    const version = ++generation.current
    let active = true
    busy.current = false
    setSaving(false)
    setLearning(null)
    setStatus("loading")
    void api
      .request("GET /bots/:id/learning", {}, { id: botId })
      .then((response) => {
        if (!active || version !== generation.current) return
        setLearning(response.learning)
        setStatus("ready")
      })
      .catch(() => {
        if (active) setStatus("error")
      })
    return () => {
      active = false
      generation.current++
    }
  }, [api, botId])
  const save = async (patch: Partial<BotLearningSettings>) => {
    if (busy.current) return
    const version = generation.current
    busy.current = true
    setSaving(true)
    try {
      const response = await api.request("PUT /bots/:id/learning", patch, { id: botId })
      if (version !== generation.current) return
      setLearning(response.learning)
      setStatus("ready")
    } catch {
      if (version === generation.current) setStatus("error")
    } finally {
      if (version === generation.current) {
        busy.current = false
        setSaving(false)
      }
    }
  }
  return (
    <article className="screen-card screen-provider-card learning-card" aria-labelledby={`learning-${botId}`}>
      <div className="screen-card-heading">
        <h3 id={`learning-${botId}`}>{t("Aprendizado contínuo")}</h3>
        <span className={`screen-status ${learning?.memory || learning?.skills ? "is-success" : ""}`}>
          {learning?.memory || learning?.skills ? t("Ativo") : t("Desligado")}
        </span>
      </div>
      <p>
        {t(
          "O bot guarda fatos que valem em toda conversa e registra procedimentos que se repetem como skills. As revisões automáticas rodam como turnos extras e usam a conta e as permissões atuais do bot.",
        )}
      </p>
      {status === "loading" && <p role="status">{t("Carregando aprendizado…")}</p>}
      {status === "error" && (
        <div>
          <p role="alert">{t("Não foi possível carregar ou salvar o aprendizado. Tente novamente.")}</p>
          <button type="button" className="outline-button" onClick={onRetry}>
            {t("Tentar novamente")}
          </button>
        </div>
      )}
      {learning &&
        [
          { file: "MEMORY.md", what: t("sobre o ambiente"), error: learning.memoryError },
          { file: "USER.md", what: t("sobre você"), error: learning.userError },
        ].map(({ file, what, error }) => {
          if (!error) return null

          return (
            <p role="alert" key={file}>
              {t(
                error === "INVALID_PATH"
                  ? "A memória {what} ({file}) está indisponível porque não é um arquivo local seguro. Substitua os links por um arquivo comum. Você ainda pode desligar o aprendizado."
                  : "Não foi possível ler a memória {what} ({file}). Verifique as permissões do arquivo. Você ainda pode desligar o aprendizado.",
                { file, what },
              )}
            </p>
          )
        })}
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
                  "A cada {count} respostas concluídas, revisa o que aprendeu sobre você e o ambiente. Memória sobre você: {user} · sobre o ambiente: {memory} caracteres.",
                  {
                    count: learning.memoryEveryTurns,
                    memory: learning.memoryError ? "—" : learning.memoryChars,
                    user: learning.userError ? "—" : learning.userChars,
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
