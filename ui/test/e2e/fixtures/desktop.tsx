import type { Bot, MachineState } from "@touri/contracts"
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { createApiClient, type UiApi } from "../../../src/api/client"
import { BotComputer } from "../../../src/components/BotComputer"
import { installComputerKillSwitch } from "../../../src/computerKillSwitch"
import { ComputerUseSettings } from "../../../src/features/computer/ComputerUseSettings"
import { DesktopPanel } from "../../../src/features/desktop/DesktopPanel"
import "../../../src/styles.css"
import "../../../src/components/bot-panel.css"

const params = new URLSearchParams(location.search)
const imageUpdate = params.get("notice")
if (imageUpdate === "updated" || imageUpdate === "rolled-back") {
  const root = document.getElementById("root")
  const machine: MachineState = {
    botId: "notice",
    status: "running",
    progress: null,
    error: null,
    memoryMb: 1024,
    createdMs: 1,
    startMs: 1,
    imageUpdate,
  }
  const api = { request: async () => ({}), subscribe: () => () => {} } as UiApi
  if (root) {
    root.classList.add("computer-window", "bot-panel-expanded")
    createRoot(root).render(
      <main>
        <BotComputer api={api} bot={{ id: "notice", name: "Lia", machine: "vm" } as Bot} machine={machine} />
      </main>,
    )
  }
} else if (params.has("headless")) {
  const root = document.getElementById("root")
  if (root)
    createRoot(root).render(
      <main style={{ padding: 24 }}>
        {params.has("settings") ? (
          <ComputerUseSettings />
        ) : (
          <BotComputer
            api={{} as import("../../../src/api/client").UiApi}
            bot={{ id: "server", name: "Bot", machine: "local" } as Bot}
            onChat={() => {
              root.dataset.action = "chat"
            }}
            onFiles={() => {
              root.dataset.action = "files"
            }}
          />
        )}
      </main>,
    )
} else {
  const endpoint = params.get("endpoint") ?? ""
  const api = createApiClient({
    endpoint: { baseUrl: endpoint, wsUrl: `${endpoint.replace("http:", "ws:")}/api/v1/events`, token: "dev-ui-token" },
  })
  installComputerKillSwitch(api)
  const { bots } = await api.request("GET /bots", {})
  const bot = bots.find((entry) => entry.id === params.get("bot"))
  const machines = params.has("running") ? (await api.request("GET /machines", {})).machines : []
  const Computer = () => {
    const [machine, setMachine] = useState<MachineState | undefined>(machines.find((entry) => entry.botId === bot?.id))
    useEffect(
      () =>
        api.subscribe(({ event }) => {
          if (event.type === "machine.updated" && event.machine.botId === bot?.id) setMachine(event.machine)
        }),
      [],
    )
    return bot ? <BotComputer api={api} bot={bot} machine={machine} autoOpen /> : null
  }
  const root = document.getElementById("root")
  if (root && params.has("running")) root.classList.add("computer-window")
  if (root && bot) createRoot(root).render(params.has("computer") ? <Computer /> : <DesktopPanel api={api} bot={bot} />)
}
