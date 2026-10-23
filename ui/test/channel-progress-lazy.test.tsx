import { render, waitFor } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { ChatPanel } from "../src/components/ChatPanel"
import type * as GroupProjection from "../src/components/groupProjection"
import { getGroupProgressFixture } from "./fixtures/groupProgress"

const loadMemberProjection = vi.hoisted(() => vi.fn())
vi.mock("../src/components/groupProjection", async (importOriginal) => {
  loadMemberProjection()

  return importOriginal<typeof GroupProjection>()
})

test("renders channel progress without loading the optional member panel projection", async () => {
  const fixture = getGroupProgressFixture()

  const view = render(
    <ChatPanel
      api={fixture.api}
      bot={fixture.bot}
      group={fixture.group}
      groupMembers={fixture.bots}
      thread={fixture.thread}
      messages={[fixture.request, fixture.reply]}
      runs={[fixture.coordination, fixture.execution]}
      computerGrant={null}
      onSend={async () => undefined}
      onRetry={async () => undefined}
      onCancel={async () => undefined}
      onSwitchBranch={async () => undefined}
      onComputerGrant={() => undefined}
      onOpenTools={() => undefined}
    />,
  )

  await waitFor(() => expect(view.container.querySelectorAll(".activity-mark")).toHaveLength(1))
  expect(loadMemberProjection).not.toHaveBeenCalled()
})
