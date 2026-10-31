export const changeMockBrowserControl = async (changeControl: () => void): Promise<void> => {
  // A real response arrives after the input task; avoid a timed pause in the fixture.
  await new Promise<void>((resolve) => {
    const transport = new MessageChannel()
    transport.port1.onmessage = () => {
      transport.port1.close()
      transport.port2.close()
      resolve()
    }
    transport.port2.postMessage(null)
  })

  changeControl()
}
