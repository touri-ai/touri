/**
 * Text that the bot saves for future sessions is read back into its prompt, so a
 * prompt-injected turn could plant standing instructions or leak secrets through it.
 * These checks reject the obvious shapes; they are a filter, not a guarantee.
 */
type Rule = { reason: string; pattern: RegExp; skills: boolean }

const RULES: ReadonlyArray<Rule> = [
  {
    reason: "instrução para ignorar regras",
    // Either word order: "ignore previous instructions" or "desconsidere as instruções anteriores".
    pattern:
      /\b(ignore|disregard|forget|override|ignorar?|desconsider[ea]r?|esque[cç]a)\b(?=[^\n]{0,80}\b(previous|prior|above|earlier|system|anteriores?|acima|sistema)\b)[^\n]{0,60}\b(instructions?|rules|prompts?|instru[cç]\S*|regras)/i,
    skills: true,
  },
  {
    reason: "tentativa de redefinir o prompt do sistema",
    pattern: /\b(system|developer)\s+(prompt|message|instructions?)\s*(override|:)/i,
    skills: true,
  },
  {
    reason: "pedido para esconder algo do usuário",
    pattern:
      /\b(do not|don't|never|n[aã]o)\s+(tell|inform|show|reveal|mention|conte|informe|mostre|revele|mencione)\b[^\n]{0,20}\b(the user|user|ao usu[aá]rio|o usu[aá]rio)\b/i,
    skills: true,
  },
  { reason: "comentário HTML oculto", pattern: /<!--[\s\S]*?-->/, skills: true },
  {
    reason: "elemento HTML oculto",
    pattern: /<[a-z]+[^>]*(display\s*:\s*none|visibility\s*:\s*hidden)/i,
    skills: true,
  },
  {
    reason: "leitura de credenciais",
    pattern:
      /\b(cat|type|print|read|leia|mostre)\b[^\n]{0,30}(\.env\b|credentials?\.json|id_rsa|id_ed25519|\.netrc|\.aws\/credentials)/i,
    skills: true,
  },
  {
    reason: "envio de dados para fora",
    pattern: /\b(send|upload|post|exfiltrate|forward|envie|mande|encaminhe)\b[^\n]{0,80}\b(to|para)\s+https?:\/\//i,
    skills: false,
  },
  { reason: "persistência por SSH", pattern: /authorized_keys|~\/\.ssh\//i, skills: true },
  {
    reason: "segredo escrito no texto",
    pattern:
      /\b(api[_-]?key|access[_-]?token|token|secret|password|passwd|senha)\b\s*[:=]\s*["']?[A-Za-z0-9_\-/+=.]{20,}/i,
    skills: true,
  },
  {
    reason: "segredo escrito no texto",
    pattern:
      /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
    skills: true,
  },
  { reason: "caractere Unicode invisível", pattern: /[​-‏‪-‮⁠-⁤﻿]/, skills: true },
]

/** Returns why the text is refused, or null when it passes. Skills may contain URLs in scripts, so the outbound rule applies to memory only. */
export const findThreat = (text: string, scope: "memory" | "skill"): string | null =>
  RULES.find((rule) => (scope === "memory" || rule.skills) && rule.pattern.test(text))?.reason ?? null
