import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { IntegrationsScreen } from "../../src/components/WorkspaceScreens"
import { installMotionTokens } from "../../src/design/spring"
import "../../src/styles.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light"
installMotionTokens(document.documentElement)
const root = document.getElementById("root")
if (root) createRoot(root).render(<IntegrationsScreen api={createMockApi()} botId="bot-mark" botName="Bot de teste" />)
