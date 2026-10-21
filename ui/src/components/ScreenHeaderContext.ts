import { createContext, type RefCallback } from "react"

export const ScreenHeaderContext = createContext<RefCallback<HTMLElement> | undefined>(undefined)
