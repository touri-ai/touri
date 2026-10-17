import type { DoctorReport } from "@touri/contracts"
import { createRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { Composer } from "../../src/components/Composer"
import { DoctorChecks } from "../../src/features/doctor/DoctorChecks"
import "../../src/styles.css"

const api = createMockApi()
const bot = api.getState().bots[0]
if (!bot) throw new Error("fixture missing")
const request = api.request
let authorized = false
window.addEventListener("vault-probe-allowed", () => {
  authorized = true
})
api.request = (async (route, input, path) =>
  route === "GET /bots/:id/provider-login/flow"
    ? { provider: bot.provider, state: authorized ? "ready" : "vault-locked" }
    : request(route, input, path)) as ApiRequest
const doctor: DoctorReport = {
  running: false,
  checks: [
    {
      id: "provider-login:test",
      label: "Login · Bot de teste · cofre",
      ok: false,
      status: "fail",
      detail: "Permita o acesso ao cofre para usar o login salvo.",
      action: "authorize-vault",
      vaultAccount: `bot/${bot.id}/${bot.provider}-vm-login`,
      fix: "claude setup-token",
    },
  ],
}
const Harness = () => {
  const [draft, setDraft] = useState("Oi! Em uma linha, o que você faz?")
  const [sent, setSent] = useState(0)
  return (
    <main style={{ maxWidth: 1000, margin: "48px auto", padding: 24 }}>
      <h1>Conversa · Bot de teste</h1>
      <Composer
        api={api}
        bot={{ ...bot, name: "Bot de teste", machine: "vm" }}
        threadId="thread"
        parentId={null}
        draft={draft}
        onDraft={setDraft}
        inputRef={createRef()}
        activeRun={null}
        queuedCount={0}
        onSend={async () => {
          setSent((count) => count + 1)
        }}
        onCancel={async () => {}}
      />
      <p role="status">Mensagens enviadas: {sent}</p>
      <h2>Diagnóstico</h2>
      <DoctorChecks
        doctor={doctor}
        error={null}
        onRefresh={async () => {
          authorized = true
        }}
      />
    </main>
  )
}
const root = document.getElementById("root")
if (!root) throw new Error("fixture root missing")
createRoot(root).render(<Harness />)
