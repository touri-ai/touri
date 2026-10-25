import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

type ApprovalFixture = { api: ReturnType<typeof createMockApi> }

const start = async () => {
  const peer = new URLSearchParams(location.search).has("peer")
  const shared: ApprovalFixture | undefined = peer ? Reflect.get(window.opener, "workApprovalFixture") : undefined
  const api = shared?.api ?? createMockApi({ scenario: "approval-notice" })
  if (!shared) {
    const { group } = await api.request("POST /groups", {
      name: "Planejamento",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
      color: "#a33",
      avatarShape: "classic-none",
    })
    if (new URLSearchParams(location.search).has("channel")) {
      const thread = api.getState().threads.find((thread) => thread.id === "thread-mark-approval")
      // The mock API exposes mutable records for seeding durable synthetic history.
      if (thread) Object.assign(thread, { groupId: group.id, kind: "chat" })
    }
  }
  localStorage.setItem("touri.sidebar.mode", "work")
  Object.assign(window, { workApprovalFixture: { api } })
  const root = document.getElementById("root")
  if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
}

void start()
