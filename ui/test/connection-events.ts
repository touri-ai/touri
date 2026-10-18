export const makeConnectionEvents = () => {
  const listeners = new Set<(connected: boolean) => void>()

  return {
    subscribeConnection: (listener: (connected: boolean) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emitConnection: (connected: boolean) => {
      listeners.forEach((listener) => {
        listener(connected)
      })
    },
  }
}
