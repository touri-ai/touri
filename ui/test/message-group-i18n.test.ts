import { describe, expect, it } from "vitest"
import { type TranslationKey, t } from "../src/i18n"

const translations = [
  ["Baixar", "Download"],
  ["Não foi possível anexar o arquivo", "Could not attach the file"],
  ["é uma pasta. Solte arquivos, não pastas.", "is a folder. Drop files, not folders."],
  ["é um atalho (link simbólico). Solte o arquivo original.", "is a shortcut (symbolic link). Drop the original file."],
  ["tem mais de 15 MB.", "is larger than 15 MB."],
  ["não é um arquivo comum e não pode ser anexado.", "is not a regular file and cannot be attached."],
  ["não pôde ser lido.", "could not be read."],
  ["passou do limite de arquivos por vez.", "exceeds the number of files allowed at once."],
  ["Não foi possível anexar {name}: {reason}", "Could not attach {name}: {reason}"],
  ["Arquivos enviados", "Sent files"],
  ["Imagem anexada", "Attached image"],
  ["Baixar {name}", "Download {name}"],
  ["Baixando…", "Downloading…"],
  ["Editar", "Edit"],
  ["Editar mensagem", "Edit message"],
  ["Salvar e enviar", "Save and send"],
  ["Enviando…", "Sending…"],
  [
    "Ao enviar, uma nova ramificação será criada. A mensagem original será mantida.",
    "Sending creates a new branch. The original message will be kept.",
  ],
  ["Não foi possível enviar. {reason}", "Could not send. {reason}"],
  ["Não foi possível anexar {name}. {reason}", "Could not attach {name}. {reason}"],
  ["Escolha um arquivo de até 15 MB", "Choose a file up to 15 MB"],
  [
    "Texto, Markdown, JSON, CSV, PDF e imagens · até 15 MB por arquivo.",
    "Text, Markdown, JSON, CSV, PDF and images · up to 15 MB per file.",
  ],
  ["Comece uma conversa com {name}", "Start a conversation with {name}"],
  ["Membros do grupo", "Group members"],
  [
    "Sem menções, todos os membros respondem na ordem da lista. Use @nome para escolher quem responde.",
    "Without mentions, all members reply in list order. Use @name to choose who replies.",
  ],
  [
    "{name} coordena as respostas e pode delegar aos membros. Use @nome para falar com um membro.",
    "{name} coordinates replies and can delegate to members. Use @name to talk to a member.",
  ],
  ["Cada bot mantém seu computador e suas permissões.", "Each bot keeps its own computer and permissions."],
  ["Seu grupo", "Your group"],
  ["Painel do grupo", "Group panel"],
  ["Painel do grupo {name}", "Group panel for {name}"],
  ["Fechar painel do grupo", "Close group panel"],
  ["Editar membros", "Edit members"],
  ["Coordenador", "Coordinator"],
  ["Conte o que o grupo deve fazer para começar.", "Tell the group what to do to get started."],
] satisfies [TranslationKey, string][]

describe("message actions, attachments and group translations", () => {
  it.each(translations)("translates %s in both languages", (key, english) => {
    expect(t(key)).toBe(key)
    expect(t(key, {}, "pt-BR")).toBe(key)
    expect(t(key, {}, "en")).toBe(english)
  })

  it("translates the ask_all member deadline for both locales", () => {
    const description: TranslationKey =
      "Send the same task to all other members of this touri group in parallel and gather final answers with authorship. Each recipient counts toward the shared six-call budget. Each member has its own 120-second execution budget, starting when that member's run starts; time waiting in the queue does not count. Same depth 2, cycle, access, secrecy and approval fences as ask_bot. A pending approval for one member does not hold up others. Only available in group participant sessions."

    expect(t(description, {}, "pt-BR")).toBe(
      "Envia a mesma tarefa aos outros membros do grupo em paralelo e reúne as respostas finais com autoria. Cada membro conta no limite compartilhado de seis chamadas e tem seu próprio prazo de execução de 120 segundos, contado a partir do início da execução do membro; o tempo na fila não conta. Mantém os limites de profundidade 2, ciclos, acesso, segredos e aprovações da delegação individual. Uma aprovação pendente para um membro não impede os outros de trabalhar. Disponível apenas nas sessões de membros do grupo.",
    )
    expect(t(description, {}, "en")).toBe(description)
  })

  it("interpolates names and translated attachment errors", () => {
    expect(t("Painel do grupo {name}", { name: "QA" }, "en")).toBe("Group panel for QA")
    expect(t("Baixar {name}", { name: "notas.txt" }, "en")).toBe("Download notas.txt")
    expect(
      t(
        "Não foi possível anexar {name}: {reason}",
        { name: "notas.txt", reason: t("tem mais de 15 MB.", {}, "en") },
        "en",
      ),
    ).toBe("Could not attach notas.txt: is larger than 15 MB.")
  })
})
