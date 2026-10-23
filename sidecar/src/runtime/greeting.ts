import type { MessagePart, RunTrigger } from "@touri/contracts"

// Only standalone greetings qualify; short task requests must keep all tools and reasoning.
export const isGreetingTurn = (trigger: RunTrigger, parts: readonly MessagePart[], text: string): boolean => {
  if (trigger !== "user" || parts.some((part) => part.type !== "text")) return false
  if (text.length > 40) return false

  return /^(?:oi|olá|ola|opa|bom dia|boa tarde|boa noite|hi|hello|hey)[!.?\s]*$/iu.test(text.trim())
}

// An allowlist avoids treating short commands, approvals or context-dependent follow-ups as chat.
export const isConversationTurn = (trigger: RunTrigger, parts: readonly MessagePart[], text: string): boolean => {
  if (isGreetingTurn(trigger, parts, text)) return true
  if (trigger !== "user" || parts.some((part) => part.type !== "text") || text.length > 100) return false

  return /^(?:tudo bem|como (?:você|voce|vc) (?:está|esta|vai)|quem (?:é|e) (?:você|voce|vc)|qual (?:é |e )?(?:o )?seu nome|o que (?:você|voce|vc) faz|obrigad[oa]|valeu|how are you|who are you|what(?:'s| is) your name|what do you do|thanks|thank you)[!.?\s]*$/iu.test(
    text.trim(),
  )
}
