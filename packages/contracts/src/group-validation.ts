/** Fixed public messages: never include a submitted value in a validation response. */
const messages = {
  body: {
    "pt-BR": "body: envie um objeto JSON com os dados do grupo.",
    en: "body: send a JSON object containing the group details.",
  },
  name: {
    "pt-BR": "name: informe um nome não vazio com até 80 caracteres.",
    en: "name: enter a non-empty name with at most 80 characters.",
  },
  color: {
    "pt-BR": "color: informe uma cor hexadecimal válida, como #dc2626.",
    en: "color: enter a valid hexadecimal color, such as #dc2626.",
  },
  avatarShape: {
    "pt-BR": "avatarShape: informe um formato de mascote válido, como classic-none.",
    en: "avatarShape: enter a valid avatar shape, such as classic-none.",
  },
  memberIds: {
    "pt-BR": "memberIds: informe de 1 a 20 bots ativos, sem IDs ou nomes repetidos.",
    en: "memberIds: provide 1 to 20 active bots, without duplicate IDs or names.",
  },
  coordinatorBotId: {
    "pt-BR": "coordinatorBotId: informe null ou o ID de um membro do grupo.",
    en: "coordinatorBotId: provide null or the ID of a group member.",
  },
  title: {
    "pt-BR": "title: informe um título não vazio com até 200 caracteres.",
    en: "title: enter a non-empty title with at most 200 characters.",
  },
} as const

export type GroupValidationField = keyof typeof messages

export const getGroupValidationError = (field: unknown) => {
  if (typeof field !== "string" || !Object.hasOwn(messages, field)) return undefined
  const errorMessages = messages[field as GroupValidationField]

  return { field: field as GroupValidationField, error: errorMessages["pt-BR"], errorMessages }
}
