import { useState } from "react"
import { createRoot } from "react-dom/client"
import { createApiClient } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { ImportWizard } from "../../src/components/Modals"
import "../../src/styles.css"

const api = createApiClient({ endpoint: { baseUrl: "", wsUrl: "", token: "synthetic-import" } })
const bots = createMockApi().getState().bots

const Harness = () => {
  const [notice, setNotice] = useState("")
  const [open, setOpen] = useState(true)

  return (
    <main>
      <p role="status">{notice}</p>
      {open && <ImportWizard bots={bots} api={api} onClose={() => setOpen(false)} onNotice={setNotice} />}
    </main>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Harness />)
