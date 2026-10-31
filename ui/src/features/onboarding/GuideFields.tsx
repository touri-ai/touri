import type { Bot, BotGroup, MachineCapability } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../../api/client"
import { ApiModelPicker } from "../../components/ApiModelPicker"
import { ApiModelsSettings } from "../../components/ApiModelsSettings"
import { BotAvatar } from "../../components/BotAvatar"
import { Button } from "../../components/Button"
import { MachineFields } from "../../components/MachineFields"
import { ProviderLogin } from "../../components/ProviderLogin"
import { ProviderModelField } from "../../components/ProviderModelField"
import { t } from "../../i18n"
import { InvitePersonDialog } from "../people/InvitePersonDialog"
import { type ComputerDraft, getToggle, getWebsite, topicOptions, type WorkspaceDraft } from "./guide"

export const WorkspaceFields = ({
  draft,
  onChange,
}: {
  draft: WorkspaceDraft
  onChange: (draft: WorkspaceDraft) => void
}) => (
  <>
    <label className="ob-field">
      {t("ob.name")}
      <input
        value={draft.name}
        maxLength={80}
        autoComplete="organization"
        required
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
      />
    </label>
    <fieldset className="ob-colors">
      <legend>{t("ob.color")}</legend>
      {colors.map((color) => (
        <Button
          key={color.token}
          aria-label={t(color.label)}
          aria-pressed={draft.color === color.token}
          className="ob-color"
          style={{ background: color.token }}
          onClick={() => onChange({ ...draft, color: color.token })}
        />
      ))}
    </fieldset>
  </>
)
const colors = [
  { token: "var(--brand)", label: "ob.red" },
  { token: "var(--warning)", label: "ob.gold" },
  { token: "var(--success)", label: "ob.green" },
  { token: "var(--link)", label: "ob.blue" },
  { token: "var(--special)", label: "ob.purple" },
] as const
export const ContextFields = ({
  draft,
  onChange,
}: {
  draft: WorkspaceDraft
  onChange: (draft: WorkspaceDraft) => void
}) => {
  const [notice, setNotice] = useState("")
  return (
    <>
      <label className="ob-field">
        {t("ob.contextLabel")}
        <textarea
          rows={4}
          value={draft.context}
          maxLength={8000}
          onChange={(event) => onChange({ ...draft, context: event.target.value })}
        />
      </label>
      <div className="ob-inline">
        <label className="ob-field ob-grow">
          {t("ob.website")}
          <input
            type="url"
            placeholder="https://example.com"
            value={draft.website}
            maxLength={2048}
            onChange={(event) => {
              onChange({ ...draft, website: event.target.value })
              setNotice("")
            }}
          />
        </label>
        <Button
          onClick={() => {
            try {
              const url = getWebsite(draft.website)
              onChange({ ...draft, website: url })
              setNotice(t("ob.websiteScheduled"))
            } catch {
              setNotice(t("ob.websiteError"))
            }
          }}
        >
          {t("ob.readWebsite")}
        </Button>
      </div>
      {notice && <p role="status">{notice}</p>}
      <fieldset className="ob-topics">
        <legend>{t("ob.timeQuestion")}</legend>
        {topicOptions.map((topic) => (
          <Button
            key={topic.id}
            aria-pressed={draft.topics.includes(topic.id)}
            onClick={() => onChange({ ...draft, topics: getToggle(draft.topics, topic.id) })}
          >
            {t(topic.label)}
          </Button>
        ))}
      </fieldset>
    </>
  )
}
export const ComputerFields = ({
  values,
  computer,
  onChange,
  api,
}: {
  api: UiApi
  values: ComputerDraft
  computer: string
  onChange: (values: ComputerDraft) => void
}) => {
  const [capability, setCapability] = useState<MachineCapability>()
  useEffect(() => {
    const controller = new AbortController()
    void api
      .request("GET /machines", {}, {}, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setCapability(result.capability)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [api])
  return (
    <div className="ob-settings-card">
      <p className="ob-computer-name">▭ {computer}</p>
      <MachineFields
        values={values}
        provider="claude"
        {...(capability ? { capability } : {})}
        onChange={(patch) => onChange({ ...values, ...patch })}
      />
      <label className="ob-setting">
        <span>
          <strong>{t("ob.browser")}</strong>
          <small>{t("ob.browserHelp")}</small>
        </span>
        <input
          type="checkbox"
          checked={values.browserEnabled}
          onChange={(event) => onChange({ ...values, browserEnabled: event.target.checked })}
        />
      </label>
      <label className="ob-setting">
        <span>
          <strong>{t("ob.terminal")}</strong>
          <small>{t("ob.terminalHelp")}</small>
        </span>
        <input
          type="checkbox"
          checked={values.access === "workspace-write"}
          onChange={(event) => onChange({ ...values, access: event.target.checked ? "workspace-write" : "read-only" })}
        />
      </label>
      <label className="ob-setting">
        <span>
          <strong>{t("ob.noApproval")}</strong>
          <small>{t("ob.noApprovalHelp")}</small>
        </span>
        <input
          type="checkbox"
          checked={values.approvals === "never"}
          onChange={(event) => onChange({ ...values, approvals: event.target.checked ? "never" : "on-request" })}
        />
      </label>
    </div>
  )
}
export const AgentFields = ({ api, bots, onChange }: { api: UiApi; bots: Bot[]; onChange: (bot: Bot) => void }) => {
  const [apiOpen, setApiOpen] = useState(false)
  const [loginId, setLoginId] = useState<string | null>(null)
  return (
    <>
      <div className="ob-inline">
        <Button onClick={() => setApiOpen((open) => !open)} aria-expanded={apiOpen}>
          {t("ob.apiKey")}
        </Button>
      </div>
      {apiOpen && (
        <div className="ob-api-editor">
          <ApiModelsSettings api={api} />
          <Button onClick={() => setApiOpen(false)}>{t("Fechar")}</Button>
        </div>
      )}
      {bots.map((bot) => (
        <article className="ob-agent-card" key={bot.id}>
          <div className="ob-inline">
            <BotAvatar bot={bot} size={36} mood="idle" />
            <strong>{bot.name}</strong>
          </div>
          <label className="ob-field">
            {t("ob.account")}
            <select
              value={bot.provider}
              onChange={(event) => onChange({ ...bot, provider: event.target.value as Bot["provider"], model: "" })}
            >
              <option value="claude">{t("ob.claudeSubscription")}</option>
              <option value="codex">{t("ob.chatSubscription")}</option>
              <option value="opencode">{t("ob.apiKey")}</option>
            </select>
          </label>
          {bot.provider !== "opencode" && (
            <Button onClick={() => setLoginId(loginId === bot.id ? null : bot.id)} aria-expanded={loginId === bot.id}>
              {t("ob.connectAccount")}
            </Button>
          )}
          {loginId === bot.id && bot.provider !== "opencode" && (
            <ProviderLogin api={api} botId={bot.id} provider={bot.provider} onConfigured={() => undefined} />
          )}
          {bot.provider === "opencode" ? (
            <ApiModelPicker
              key={`${bot.id}-${apiOpen}`}
              api={api}
              id={`ob-model-${bot.id}`}
              value={bot.model ?? ""}
              onChange={(model) => onChange({ ...bot, model })}
            />
          ) : (
            <label className="ob-field" htmlFor={`ob-model-${bot.id}`}>
              {t("ob.model")}
              <ProviderModelField
                api={api}
                id={`ob-model-${bot.id}`}
                botId={bot.id}
                provider={bot.provider}
                value={bot.model ?? ""}
                onChange={(model) => onChange({ ...bot, model })}
              />
            </label>
          )}
        </article>
      ))}
    </>
  )
}
export const TeamFields = ({ api, groups, onInvited }: { api: UiApi; groups: BotGroup[]; onInvited: () => void }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <p>{t("ob.inviteHelp")}</p>
      <Button onClick={() => setOpen(true)}>{t("ob.invitePerson")}</Button>
      {open && (
        <InvitePersonDialog
          channels={groups}
          initialChannelId={groups.find((group) => group.name === "geral")?.id ?? ""}
          request={async (route, input, paths, transport) => {
            const result = await api.request(route, input, paths, transport)
            if (route === "POST /invites") onInvited()
            return result
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
