import type { MessagePart, RunTrigger } from "@touri/contracts"

// Only standalone greetings qualify; short task requests must keep all tools and reasoning.
export const isGreetingTurn = (trigger: RunTrigger, parts: readonly MessagePart[], text: string): boolean => {
  if (trigger !== "user" || parts.some((part) => part.type !== "text")) return false
  if (text.length > 40) return false

  return /^(?:oi|olá|ola|opa|bom dia|boa tarde|boa noite|hi|hello|hey)[!.?\s]*$/iu.test(text.trim())
}
