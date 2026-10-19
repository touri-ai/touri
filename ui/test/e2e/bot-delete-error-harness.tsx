import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { setDocumentLanguage } from "../../src/documentLanguage"
import { getBotDeletionFixture } from "../fixtures/botDeletion"
import "../../src/styles.css"

const params = new URLSearchParams(location.search)
const fixture = getBotDeletionFixture(params.get("cleanup") === "pending" ? "pending" : "blocked")
setDocumentLanguage(params.get("lang") === "en" ? "en" : "pt-BR", document.documentElement)
Object.assign(window, { botDeletionQa: { finishCleanup: fixture.finishCleanup } })
const root = document.getElementById("root")
if (!root) throw new Error("Missing deletion fixture root")
createRoot(root).render(<App kernel={{ services: { api: fixture.api } }} />)
