import { createRoot } from "react-dom/client"
import { createApiClient } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { DeleteBotDialog } from "../../src/components/DeleteBotDialog"
import "../../src/styles.css"

const api = createApiClient({
  endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1", token: "test" },
  fetchImpl: async () => Response.json({ code: "TOURI-E8004" }, { status: 409 }),
})
const bot = createMockApi().getState().bots[0]
const root = document.getElementById("root")
if (root && bot)
  createRoot(root).render(
    <DeleteBotDialog
      bot={bot}
      onDelete={async (id, name, deleteVolumes) => {
        await api.request("DELETE /bots/:id", { name, deleteVolumes }, { id })
      }}
      onClose={() => {}}
    />,
  )
