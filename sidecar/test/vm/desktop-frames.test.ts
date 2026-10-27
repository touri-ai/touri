import { expect, test } from "bun:test"
import { DesktopFrames } from "../../src/vm/desktop-frames"

const getController = (interval: number) => {
  const sent: Buffer[] = []
  const controller = new DesktopFrames(interval, (packet) => sent.push(packet))

  return { controller, sent }
}
const getRequest = (incremental = true) => Buffer.from([3, Number(incremental), 0, 0, 0, 0, 5, 160, 3, 132])

test("human control sends consecutive requests without a pacing timer", () => {
  const { controller, sent } = getController(0)

  controller.request(getRequest())
  controller.request(getRequest())

  expect(sent).toHaveLength(2)
})

test("watching coalesces requests and preserves a full refresh", async () => {
  const { controller, sent } = getController(25)

  controller.request(getRequest())
  controller.request(getRequest(false))
  controller.request(getRequest())

  expect(sent).toHaveLength(1)
  await Bun.sleep(50)
  expect(sent).toHaveLength(2)
  expect(sent[1]?.[1]).toBe(0)
})

test("hiding holds one request, returning resumes it, and disposal cancels it", async () => {
  const { controller, sent } = getController(25)

  controller.request(getRequest())
  controller.request(getRequest(false))
  controller.setVisible(false)
  controller.request(getRequest())
  await Bun.sleep(50)

  expect(sent).toHaveLength(1)
  controller.setVisible(true)
  expect(sent[1]?.[1]).toBe(0)
  controller.request(getRequest())
  controller.dispose()
  await Bun.sleep(50)
  expect(sent).toHaveLength(2)
})
