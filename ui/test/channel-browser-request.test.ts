import { expect, test, vi } from "vitest"
import { changeMockBrowserControl } from "./e2e/channel-browser-request"

test("a control response yields beyond the input task and its microtasks", async () => {
  const changeControl = vi.fn()

  const response = changeMockBrowserControl(changeControl)
  await Promise.resolve()

  expect(changeControl).not.toHaveBeenCalled()

  await response

  expect(changeControl).toHaveBeenCalledExactlyOnceWith()
})
