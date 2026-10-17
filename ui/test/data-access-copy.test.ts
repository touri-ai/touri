import { expect, it } from "vitest"
import { t } from "../src/i18n"

it.each([
  ["Enviar arquivo deste dispositivo", "Send a file from this device"],
  ["Escolher pasta do servidor", "Choose a server folder"],
  ["Pastas no servidor", "Server folders"],
  ["Somente leitura", "Read only"],
  ["Anexar CSV", "Attach CSV"],
  ["Continuar tarefa", "Continue task"],
  [
    "A conexão direta com esta fonte ainda não está disponível. Exporte um CSV para começar.",
    "A direct connection to this source is not available yet. Export a CSV to get started.",
  ],
  [
    "Não foi possível liberar a pasta com segurança. Seu bot continua disponível.",
    "Folder access could not be granted safely. Your bot is still available.",
  ],
  [
    "Esta pasta fica no servidor. Para enviar um arquivo do celular ou computador, use Enviar arquivo deste dispositivo.",
    "This folder is on the server. To send a file from your phone or computer, use Send a file from this device.",
  ],
  [
    "Esta pasta fica fora das pastas autorizáveis do servidor.",
    "This folder is outside the server’s available folder roots.",
  ],
] as const)("offers the same data choice in both languages: %s", (pt, en) => {
  expect(t(pt, {}, "pt-BR")).toBe(pt)
  expect(t(pt, {}, "en")).toBe(en)
})

it("names the chosen context in both languages", () => {
  expect(t("Dados disponíveis para {bot}.", { bot: "Dados" }, "pt-BR")).toBe("Dados disponíveis para Dados.")
  expect(t("Dados disponíveis para {bot}.", { bot: "Data" }, "en")).toBe("Data available for Data.")
  expect(t("Conexão disponível: {name}", { name: "dados" }, "en")).toBe("Connection available: dados")
})

// Redundant setup confirms existing access without implying a project was linked.
it.each([
  [
    "Este bot já tem acesso a esta pasta. Nenhuma permissão foi alterada.",
    "This bot already has access to this folder. No permissions were changed.",
  ],
  [
    "Para usar processos supervisionados e o Preview, vincule o projeto nas configurações do bot.",
    "To use supervised processes and Preview, link the project in the bot settings.",
  ],
] as const)("localizes unchanged folder access: %s", (key, english) => {
  expect(t(key, {}, "pt-BR")).toBe(key)
  expect(t(key, {}, "en")).toBe(english)
})
