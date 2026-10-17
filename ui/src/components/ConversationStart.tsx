import type { Bot } from "@touri/contracts"
import { getJobTemplates } from "../features/jobs/catalog"
import { markdownSummary } from "../markdownSummary"
import { BotAvatar } from "./BotAvatar"

const catalogJobs = [...getJobTemplates(), ...getJobTemplates("en")]

const examplesFor = (bot: Bot | null): string[] => {
  const job = catalogJobs.find((job) => job.roleLine === bot?.roleLine?.trim())
  if (job) return job.starterPrompts
  const role = markdownSummary(bot?.roleLine?.trim() || bot?.description?.trim() || "")
  const normalized = role.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/\p{M}/gu, "")
  if (/\b(seo|marketing)\b/.test(normalized))
    return ["Revise o SEO desta página.", "Sugira melhorias para este conteúdo.", "Monte um plano de conteúdo."]
  if (/\b(qa|testes|qualidade|tester)\b/.test(normalized))
    return [
      "Sugira um plano de testes para este fluxo.",
      "Revise os casos de erro desta tela.",
      "Crie uma lista de verificação.",
    ]
  if (/\b(review|revisor|revisao)\b/.test(normalized))
    return ["Revise estas alterações.", "Procure riscos nesta implementação.", "Sugira melhorias para estes testes."]
  if (/\b(mail|email|e-mail|correio)\b/.test(normalized))
    return [
      "Ajude a redigir uma resposta.",
      "Organize estas mensagens por prioridade.",
      "Resuma os próximos passos deste e-mail.",
    ]
  if (/\b(release|lancamento|publicacao)\b/.test(normalized))
    return [
      "Monte uma lista de verificação para a próxima versão.",
      "Resuma estas mudanças para o lançamento.",
      "Revise os requisitos da versão.",
    ]
  if (/\b(pm|produto|product|gerente|coordenador|coordenacao)\b/.test(normalized))
    return [
      "Transforme esta ideia em critérios de aceite.",
      "Ajude a priorizar estas tarefas.",
      "Sugira os próximos passos deste projeto.",
    ]
  if (/\b(dev|developer|desenvolvedor|desenvolvimento|coder|programador|engenheiro)\b/.test(normalized))
    return [
      "Explique a estrutura deste projeto.",
      "Ajude a investigar este erro.",
      "Sugira uma implementação para esta tarefa.",
    ]
  return [
    role
      ? `Como você pode ajudar em ${role.length > 70 ? `${role.slice(0, 69)}…` : role}?`
      : "Explique como você pode me ajudar.",
    "Resuma o contexto deste projeto.",
    "Sugira três próximos passos.",
  ]
}

export const ConversationStart = ({ bot, onChoose }: { bot: Bot | null; onChoose: (prompt: string) => void }) => (
  <section className="conversation-start" aria-label={`Comece uma conversa com ${bot?.name ?? "touri"}`}>
    {bot && (
      <div className="conversation-start-avatar">
        <BotAvatar bot={bot} size={36} state="idle" />
      </div>
    )}
    <h2>Comece uma conversa com {bot?.name ?? "touri"}</h2>
    <p>Conte o que você quer fazer ou escolha uma ideia para começar.</p>
    <div className="conversation-examples">
      {examplesFor(bot).map((prompt) => (
        <button type="button" key={prompt} className="button button-quiet" onClick={() => onChoose(prompt)}>
          <span>{prompt}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="M4 12h16m-6-6 6 6-6 6" />
          </svg>
        </button>
      ))}
    </div>
  </section>
)
