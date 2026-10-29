import { createContext, type ReactNode, useContext, useState } from "react"

const NotificationsOpenContext = createContext(false)
const SetNotificationsOpenContext = createContext<(open: boolean) => void>(() => undefined)

export const NotificationVisibilityProvider = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false)

  return (
    <SetNotificationsOpenContext.Provider value={setOpen}>
      <NotificationsOpenContext.Provider value={open}>{children}</NotificationsOpenContext.Provider>
    </SetNotificationsOpenContext.Provider>
  )
}

export const useNotificationsOpen = (): boolean => useContext(NotificationsOpenContext)

export const useSetNotificationsOpen = (): ((open: boolean) => void) => useContext(SetNotificationsOpenContext)
