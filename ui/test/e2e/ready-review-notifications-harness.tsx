import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { initializeTheme } from "../../src/design/theme"
import { getReadyReviewFixture } from "../fixtures/ready-review"
import "../../src/styles.css"

initializeTheme()

const render = async () => {
  const { api } = await getReadyReviewFixture()
  const root = document.getElementById("root")
  if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
}

void render()
