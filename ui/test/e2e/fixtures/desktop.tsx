import type { Bot, MachineState } from "@touri/contracts"
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { createApiClient } from "../../../src/api/client"
import { BotComputer } from "../../../src/components/BotComputer"
import { installComputerKillSwitch } from "../../../src/computerKillSwitch"
import { ComputerUseSettings } from "../../../src/features/computer/ComputerUseSettings"
import { DesktopPanel } from "../../../src/features/desktop/DesktopPanel"
import "../../../src/styles.css"

const params = new URLSearchParams(location.search)
if (params.has("headless")) {
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
  const Computer = () => {
    const [machine, setMachine] = useState<MachineState>()
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
  if (root && bot) createRoot(root).render(params.has("computer") ? <Computer /> : <DesktopPanel api={api} bot={bot} />)
}
