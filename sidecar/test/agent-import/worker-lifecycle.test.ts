import { expect, test } from "bun:test"
import { getAgentImportManualAsync } from "../../src/kernel/async-files"

test("the shared file worker still accepts previews after earlier import test files finish", async () => {
  const payload = {
    agents: [
      {
        name: "Notas",
        personality: "Organiza notas",
        instructions: "Use frases curtas.",
        skills: [],
        memories: [],
        routines: [],
        integrations: [],
      },
    ],
  }

  const snapshot = await getAgentImportManualAsync(payload)

  expect(snapshot.agents).toMatchObject([{ name: "Notas", instructions: ["Use frases curtas."] }])
})
