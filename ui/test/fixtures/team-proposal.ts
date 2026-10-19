import type { TeamProposalReview } from "@touri/contracts"

export const getTeamReview = (): TeamProposalReview => ({
  proposal: {
    bots: [
      {
        name: "Pesquisa",
        roleLine: "Encontra fontes para os posts da semana.",
        instructions: "Confirme o tema. Reúna fontes verificáveis e entregue links e dúvidas para Escrita.",
        provider: "codex",
        avatarShape: "cercle",
        color: "#5C7CFA",
      },
      {
        name: "Escrita",
        roleLine: "Transforma as fontes em rascunhos claros.",
        instructions:
          "Use as fontes da Pesquisa, prepare um rascunho e peça à Revisão para conferir antes de apresentar à pessoa.",
        provider: "claude",
        avatarShape: "squircle",
        color: "#E599F7",
      },
      {
        name: "Revisão",
        roleLine: "Confere fatos, clareza e tom antes da publicação.",
        instructions:
          "Confira as fontes e sinalize dúvidas. Entregue sugestões para aprovação da pessoa; não publique por conta própria.",
        provider: "opencode",
        avatarShape: "cercle",
        color: "#63E6BE",
      },
    ],
    group: { name: "Conteúdo semanal", members: ["Pesquisa", "Escrita", "Revisão"], coordinator: "Escrita" },
  },
  providers: [
    { provider: "codex", status: "ready" },
    { provider: "claude", status: "ready" },
    { provider: "opencode", status: "needs-setup" },
  ],
})
