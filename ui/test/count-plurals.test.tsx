import { render, screen, within } from "@testing-library/react"
import type { ApiRoutes, BotGroup } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import CronScreen from "../src/components/CronScreen"
import { GroupHeader } from "../src/components/Groups"
import { DoctorStorage } from "../src/features/doctor/DoctorStorage"
import { type Locale, type TranslationKey, t } from "../src/i18n"
import { routineSchedule } from "../src/routineSchedule"
import type { WorkspaceActions } from "../src/useWorkspace"

const counts = [0, 1, 2]
const locales: Locale[] = ["pt-BR", "en"]
const labels: [TranslationKey, string, string, string, string][] = [
  ["Group member count", "membro", "membros", "member", "members"],
  ["Bot routine count", "rotina", "rotinas", "routine", "routines"],
  ["Pending approval count", "aprovação pendente", "aprovações pendentes", "pending approval", "pending approvals"],
  ["Unread messages", "mensagem não lida", "mensagens não lidas", "unread message", "unread messages"],
  ["Tool count", "chamada de ferramenta", "chamadas de ferramenta", "tool call", "tool calls"],
  ["Minutes", "minuto", "minutos", "minute", "minutes"],
]

describe.each(locales)("count labels in %s", (locale) => {
  it.each(counts)("uses the correct visible and accessible group count for %i members", (count) => {
    const bots = createMockApi().getState().bots.slice(0, count)
    const group: BotGroup = {
      id: "group",
      name: "Equipe",
      color: "#dc2626",
      avatarShape: "classic-none",
      avatarSeed: "group",
      memberIds: bots.map((bot) => bot.id),
      coordinatorBotId: null,
      createdAt: 0,
      updatedAt: 0,
    }
    const memberCount =
      locale === "pt-BR" ? ["0 membros", "1 membro", "2 membros"][count] : ["0 members", "1 member", "2 members"][count]
    if (!memberCount) throw new Error("Missing expected count")
    const view = render(<GroupHeader group={group} bots={bots} onEdit={vi.fn()} locale={locale} />)
    expect(screen.getByText(memberCount, { exact: true })).toBeVisible()
    expect(
      screen.getByRole("img", {
        name: count ? `${memberCount}: ${bots.map((bot) => bot.name).join(", ")}` : memberCount,
        exact: true,
      }),
    ).toBeVisible()
    expect(within(view.container).getAllByRole("button")).toHaveLength(1)
  })

  it.each(labels)("pluralizes %s for zero, one and two", (key, ptOne, ptOther, enOne, enOther) => {
    const [one, other] = locale === "pt-BR" ? [ptOne, ptOther] : [enOne, enOther]
    expect(counts.map((count) => t(key, { count }, locale))).toEqual([`0 ${other}`, `1 ${one}`, `2 ${other}`])
  })

  it.each(counts)("pluralizes both independent import counts when there are %i messages", (messages) => {
    for (const threads of counts) {
      const expected =
        locale === "pt-BR"
          ? `${messages} ${messages === 1 ? "mensagem" : "mensagens"} e ${threads} ${threads === 1 ? "conversa importada" : "conversas importadas"}. As rotinas estão pausadas.`
          : `${messages} ${messages === 1 ? "message" : "messages"} and ${threads} imported ${threads === 1 ? "conversation" : "conversations"}. Routines are paused.`
      expect(t("Import counts", { messages, threads }, locale)).toBe(expected)
    }
  })

  it.each(counts)("pluralizes hourly schedule minutes for %i", (minute) => {
    const label =
      locale === "pt-BR"
        ? ["A cada hora", "A cada hora, ao 1 minuto", "A cada hora, aos 2 minutos"][minute]
        : ["Every hour", "Every hour at 1 minute past", "Every hour at 2 minutes past"][minute]
    expect(routineSchedule(`${minute} * * * *`, "UTC", locale)).toBe(`${label} · UTC`)
  })

  it.each(counts)("pluralizes interval units and character counts for %i", (count) => {
    const minute = locale === "pt-BR" ? ["minuto", "minutos"] : ["minute", "minutes"]
    const hour = locale === "pt-BR" ? ["hora", "horas"] : ["hour", "hours"]
    const character = locale === "pt-BR" ? ["caractere", "caracteres"] : ["character", "characters"]
    const form = count === 1 ? 0 : 1
    const every = locale === "pt-BR" ? "A cada" : "Every"
    const length = locale === "pt-BR" ? "Tamanho completo:" : "Full length:"
    expect(t("A cada {count} minutos", { count }, locale)).toBe(`${every} ${count} ${minute[form]}`)
    expect(t("A cada {count} horas", { count }, locale)).toBe(`${every} ${count} ${hour[form]}`)
    expect(t("Tamanho completo: {count} caracteres", { count }, locale)).toBe(`${length} ${count} ${character[form]}`)
  })

  it.each(counts)("pluralizes the full routine execution sentence for %i", (count) => {
    const expected =
      locale === "pt-BR"
        ? `${count} ${count === 1 ? "rotina · executada" : "rotinas · executadas"} enquanto o touri está aberto`
        : `${count} ${count === 1 ? "routine · runs" : "routines · run"} while touri is open`
    expect(t("Routine execution count", { count }, locale)).toBe(expected)
  })

  it.each(counts)("pluralizes storage progress for %i total records", (count) => {
    const expected =
      locale === "pt-BR"
        ? `0 de ${count} ${count === 1 ? "registro processado" : "registros processados"}`
        : `0 of ${count} ${count === 1 ? "record processed" : "records processed"}`
    expect(t("Storage records processed", { processed: "0", total: String(count), count }, locale)).toBe(expected)
  })
})

it.each(counts)("renders routine agreement for %i routines", async (count) => {
  const api = createMockApi()
  const routine = (await api.request("GET /routines", {})).routines[0]
  if (!routine) throw new Error("Missing routine")
  render(
    <CronScreen
      host="server"
      selectedBotId={null}
      bots={api.getState().bots}
      routines={Array.from({ length: count }, (_, index) => ({ ...routine, id: `routine-${index}` }))}
      routineRuns={[]}
      messages={[]}
      actions={{} as WorkspaceActions}
      onReviewApprovals={vi.fn()}
      onNotice={vi.fn()}
    />,
  )
  expect(
    screen.getByText(
      `${count} ${count === 1 ? "rotina" : "rotinas"} · Funciona enquanto o touri estiver em execução no servidor. Você pode fechar esta página.`,
    ),
  ).toBeVisible()
})

it.each(counts)("renders storage agreement for %i total records", async (count) => {
  const base = createMockApi()
  const report: ApiRoutes["GET /doctor/storage"]["res"] = await base.request("GET /doctor/storage", {})
  report.maintenance = { running: true, processed: 0, total: count }
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /doctor/storage" ? (report as never) : base.request(route, input, path)
  render(<DoctorStorage api={{ ...base, request }} />)
  expect(
    await screen.findByText(`0 de ${count} ${count === 1 ? "registro processado" : "registros processados"}`),
  ).toBeVisible()
})
