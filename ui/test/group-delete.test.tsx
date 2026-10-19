import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { BotGroup } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { GroupSidebar } from "../src/components/Groups"
import { ApiError } from "../src/errors"
import type { Locale } from "../src/i18n"
import { useWorkspace } from "../src/useWorkspace"

const getGroup = (): BotGroup => ({
  id: "group-qa",
  name: "Equipe QA",
  color: "#dc2626",
  avatarShape: "classic-none",
  avatarSeed: "group-qa",
  memberIds: [],
  coordinatorBotId: null,
  createdAt: 100,
  updatedAt: 100,
})

const renderSidebar = (locale: Locale = "pt-BR", onDelete = vi.fn().mockResolvedValue(undefined)) => {
  const onEdit = vi.fn()
  render(
    <GroupSidebar
      groups={[getGroup()]}
      bots={[]}
      threads={[]}
      selectedThreadId={null}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onEdit={onEdit}
      onNewThread={vi.fn()}
      onDelete={onDelete}
      locale={locale}
    />,
  )

  return { onEdit, onDelete }
}

const openConfirmation = () => {
  fireEvent.click(screen.getByRole("button", { name: "Ações do grupo Equipe QA" }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Apagar grupo" }))

  return screen.getByRole("dialog", { name: "Apagar grupo" })
}

const createGroup = (api: ReturnType<typeof createMockApi>) =>
  api.request("POST /groups", {
    name: "Equipe QA",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: "bot-mark",
  })

const getSnapshotBarrier = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

describe("group deletion", () => {
  it("opens an accessible actions menu for an empty group and keeps editing available", async () => {
    const user = userEvent.setup()
    const { onEdit, onDelete } = renderSidebar()
    const trigger = screen.getByRole("button", { name: "Ações do grupo Equipe QA" })

    trigger.focus()
    await user.keyboard("{ArrowDown}")

    const menu = screen.getByRole("menu", { name: "Ações do grupo Equipe QA" })
    expect(menu.parentElement).toBe(document.body)
    expect(within(menu).getByRole("menuitem", { name: "Editar grupo" })).toHaveFocus()
    expect(within(menu).getByRole("menuitem", { name: "Apagar grupo" })).toBeVisible()
    expect(onEdit).not.toHaveBeenCalled()

    await user.keyboard("{Enter}")

    expect(onEdit).toHaveBeenCalledWith(getGroup())
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("requires the exact group name and cancels without deleting", async () => {
    const { onDelete } = renderSidebar()
    const dialog = openConfirmation()
    const name = within(dialog).getByLabelText("Digite o nome do grupo: Equipe QA")
    const confirm = within(dialog).getByRole("button", { name: "Apagar grupo" })

    expect(name).toHaveFocus()
    expect(confirm).toBeDisabled()
    expect(dialog).toHaveTextContent("conversas, mensagens e rotinas")
    expect(dialog).toHaveTextContent("Os bots e suas conversas individuais são preservados.")

    fireEvent.change(name, { target: { value: "Equipe QA " } })

    expect(confirm).toBeDisabled()

    fireEvent.change(name, { target: { value: "Equipe QA" } })
    fireEvent.keyDown(name, { key: "Enter" })

    expect(confirm).toBeEnabled()
    expect(onDelete).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }))

    expect(screen.queryByRole("dialog", { name: "Apagar grupo" })).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Ações do grupo Equipe QA" })).toHaveFocus()
  })

  it("keeps a failed deletion open with a clear error and allows another attempt", async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "", "GROUP_BUSY"))
      .mockResolvedValueOnce(undefined)
    renderSidebar("pt-BR", onDelete)
    const dialog = openConfirmation()
    fireEvent.change(within(dialog).getByLabelText("Digite o nome do grupo: Equipe QA"), {
      target: { value: "Equipe QA" },
    })

    fireEvent.click(within(dialog).getByRole("button", { name: "Apagar grupo" }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Aguarde as respostas terminarem ou cancele os turnos antes de apagar o grupo.",
    )
    expect(within(dialog).getByRole("button", { name: "Apagar grupo" })).toBeEnabled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Apagar grupo" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Apagar grupo" })).toBeNull())
    expect(onDelete).toHaveBeenCalledTimes(2)
    expect(onDelete).toHaveBeenLastCalledWith("group-qa")
  })

  it("translates the group menu and confirmation to English", () => {
    renderSidebar("en")

    fireEvent.click(screen.getByRole("button", { name: "Actions for group Equipe QA" }))

    expect(screen.getByRole("menuitem", { name: "Edit group" })).toBeVisible()

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }))

    const dialog = screen.getByRole("dialog", { name: "Delete group" })
    expect(within(dialog).getByLabelText("Type the group name: Equipe QA")).toBeVisible()
    expect(dialog).toHaveTextContent("Deleting Equipe QA removes all conversations, messages and routines")
    expect(dialog).toHaveTextContent("Bots and their individual conversations are kept.")
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeVisible()
  })

  it("removes a selected group's history and schedules while keeping individual conversations", async () => {
    const api = createMockApi()
    const { group, thread } = await createGroup(api)
    const originalThreadIds = api
      .getState()
      .threads.filter((candidate) => !candidate.groupId)
      .map((candidate) => candidate.id)
    const { routine } = await api.request("POST /routines", {
      botId: "bot-mark",
      name: "Rotina do grupo QA",
      prompt: "Revise o material fictício.",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: false,
      continuity: "new-thread",
      resultsThreadId: null,
      groupId: group.id,
      timeoutMinutes: 10,
      overlap: "skip",
      catchUpMinutes: 0,
    })
    const { result } = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(result.current.data.loaded).toBe(true))

    act(() => result.current.actions.selectThread(thread.id))
    await act(async () => {
      await api.request(
        "POST /threads/:id/messages",
        {
          threadId: thread.id,
          text: "Mensagem fictícia do grupo.",
          parentId: null,
          attachmentIds: [],
        },
        { id: thread.id },
      )
    })
    await waitFor(async () => {
      const { runs } = await api.request("GET /threads/:id/runs", { all: true }, { id: thread.id })
      expect(runs[0]?.status).toBe("succeeded")
    })
    act(() => {
      api.notify({ kind: "done", title: "Grupo concluído", body: "Revisão fictícia.", threadId: thread.id })
    })

    await act(() => result.current.actions.deleteGroup(group.id))

    expect(result.current.data.groups).toEqual([])
    expect(result.current.data.selectedThreadId).not.toBe(thread.id)
    expect(result.current.data.threads.map((candidate) => candidate.id)).toEqual(originalThreadIds)
    expect(result.current.data.messages.some((message) => message.threadId === thread.id)).toBe(false)
    expect(result.current.data.activityMessages.some((message) => message.threadId === thread.id)).toBe(false)
    expect(result.current.data.runs.some((run) => run.threadId === thread.id)).toBe(false)
    expect(result.current.data.notifications.some((item) => item.threadId === thread.id)).toBe(false)
    expect(result.current.data.routines.some((candidate) => candidate.id === routine.id)).toBe(false)
    expect(result.current.data.routines.some((candidate) => candidate.id === "routine-daily")).toBe(true)
    expect(api.getState().bots.map((bot) => bot.id)).toContain("bot-mark")
    expect(api.getState().messages.some((message) => message.threadId === thread.id)).toBe(false)
    expect((await api.request("GET /routines", {})).routines.some((candidate) => candidate.id === routine.id)).toBe(
      false,
    )
  })

  it("responds to group deletion from another client without deleting unrelated threads", async () => {
    const api = createMockApi()
    const { group, thread } = await createGroup(api)
    const { result } = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(result.current.data.loaded).toBe(true))

    act(() => result.current.actions.selectThread(thread.id))
    await act(async () => {
      await api.request("DELETE /groups/:id", {}, { id: group.id })
    })

    expect(result.current.data.groups).toEqual([])
    expect(result.current.data.selectedThreadId).not.toBe(thread.id)
    expect(result.current.data.threads.some((candidate) => candidate.id === "thread-mark")).toBe(true)
    expect(api.calls.filter((call) => call.route === "DELETE /groups/:id")).toHaveLength(1)
  })

  it("replaces an in-flight resync so an old group index cannot restore a deleted group", async () => {
    const api = createMockApi()
    const { group, thread } = await createGroup(api)
    const barrier = getSnapshotBarrier()
    const request: ApiRequest = async (route, input, pathValues) => {
      const isDelayedSnapshot = route === "GET /groups" && api.calls.filter((call) => call.route === route).length === 1
      const response = await api.request(route, input, pathValues)
      if (isDelayedSnapshot) await barrier.promise

      return response
    }
    const client = { ...api, request }
    const { result } = renderHook(() => useWorkspace(client))
    await waitFor(() => expect(result.current.data.loaded).toBe(true))
    act(() => api.emit({ type: "transcript.resync" }))
    await waitFor(() => expect(api.calls.filter((call) => call.route === "GET /groups")).toHaveLength(2))

    await act(async () => {
      api.emit({ type: "transcript.resync" })
      await api.request("DELETE /groups/:id", {}, { id: group.id })
    })
    await act(async () => barrier.resolve())

    expect(api.calls.filter((call) => call.route === "GET /groups")).toHaveLength(3)
    expect(result.current.data.groups).toEqual([])
    expect(result.current.data.threads.some((candidate) => candidate.id === thread.id)).toBe(false)
    expect(result.current.data.loading).toBe(false)
    expect(result.current.data.loaded).toBe(true)
    expect(result.current.data.threads.some((candidate) => candidate.id === "thread-mark")).toBe(true)
  })

  it("ignores an older attention snapshot after deleting a group", async () => {
    const api = createMockApi()
    const { group, thread } = await createGroup(api)
    const sent = await api.request(
      "POST /threads/:id/messages",
      {
        threadId: thread.id,
        text: "Histórico fictício do grupo.",
        parentId: null,
        attachmentIds: [],
      },
      { id: thread.id },
    )
    if (!sent.run) throw new Error("Missing group run")
    await api.request("POST /runs/:id/cancel", {}, { id: sent.run.id })
    api.notify({ kind: "done", title: "Grupo concluído", body: "Revisão fictícia.", threadId: thread.id })
    const barrier = getSnapshotBarrier()
    const request: ApiRequest = async (route, input, pathValues) => {
      const isAttentionSnapshot = route === "GET /workspace/activity" || route === "GET /notifications"
      const isDelayedSnapshot = isAttentionSnapshot && api.calls.filter((call) => call.route === route).length === 1
      const response = await api.request(route, input, pathValues)
      if (isDelayedSnapshot) await barrier.promise

      return response
    }
    const client = { ...api, request }
    const { result } = renderHook(() => useWorkspace(client))
    await waitFor(() => expect(result.current.data.loaded).toBe(true))
    act(() => window.dispatchEvent(new Event("online")))
    await waitFor(() => expect(api.calls.filter((call) => call.route === "GET /workspace/activity")).toHaveLength(2))

    await act(() => result.current.actions.deleteGroup(group.id))
    await act(async () => barrier.resolve())

    expect(result.current.data.groups).toEqual([])
    expect(result.current.data.messages.some((message) => message.threadId === thread.id)).toBe(false)
    expect(result.current.data.activityMessages.some((message) => message.threadId === thread.id)).toBe(false)
    expect(result.current.data.notifications.some((item) => item.threadId === thread.id)).toBe(false)
    expect(result.current.data.messages.some((message) => message.threadId === "thread-mark")).toBe(true)
    expect(result.current.data.loading).toBe(false)
    expect(result.current.data.loaded).toBe(true)
  })

  it("ignores a group history snapshot that arrives after the group has been deleted", async () => {
    const api = createMockApi()
    const { group, thread } = await createGroup(api)
    const sent = await api.request(
      "POST /threads/:id/messages",
      {
        threadId: thread.id,
        text: "Histórico fictício a apagar.",
        parentId: null,
        attachmentIds: [],
      },
      { id: thread.id },
    )
    if (!sent.run) throw new Error("Missing group run")
    await api.request("POST /runs/:id/cancel", {}, { id: sent.run.id })
    const barrier = getSnapshotBarrier()
    const request: ApiRequest = async (route, input, pathValues) => {
      const response = await api.request(route, input, pathValues)
      if (pathValues?.id === thread.id && (route === "GET /threads/:id/messages" || route === "GET /threads/:id/runs"))
        await barrier.promise

      return response
    }
    const client = { ...api, request }
    const { result } = renderHook(() => useWorkspace(client))
    await waitFor(() => expect(result.current.data.loaded).toBe(true))
    act(() => result.current.actions.selectThread(thread.id))
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.route === "GET /threads/:id/messages" && call.pathValues.id === thread.id),
      ).toBe(true),
    )

    await act(() => result.current.actions.deleteGroup(group.id))
    await act(async () => barrier.resolve())

    expect(result.current.data.threads.some((candidate) => candidate.id === thread.id)).toBe(false)
    expect(result.current.data.messages.some((message) => message.threadId === thread.id)).toBe(false)
    expect(result.current.data.runs.some((run) => run.threadId === thread.id)).toBe(false)
    expect(result.current.data.messages.some((message) => message.threadId === "thread-mark")).toBe(true)
  })

  it("cleans bot membership and coordinator references and deletes a group after its last member is removed", async () => {
    const api = createMockApi()
    const { group } = await createGroup(api)

    await api.request("DELETE /bots/:id", { name: "mark", deleteVolumes: false }, { id: "bot-mark" })

    expect((await api.request("GET /groups", {})).groups[0]).toMatchObject({
      memberIds: ["bot-onb"],
      coordinatorBotId: null,
    })

    await api.request("DELETE /bots/:id", { name: "onb", deleteVolumes: false }, { id: "bot-onb" })

    expect((await api.request("GET /groups", {})).groups[0]?.memberIds).toEqual([])

    await api.request("DELETE /groups/:id", {}, { id: group.id })

    expect((await api.request("GET /groups", {})).groups).toEqual([])
    expect(api.getState().bots.map((bot) => bot.id)).toContain("bot-panko")
    await expect(api.request("DELETE /groups/:id", {}, { id: group.id })).rejects.toMatchObject({ status: 404 })
  })
})
