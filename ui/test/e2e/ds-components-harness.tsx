import { createRoot } from "react-dom/client"
import { Badge, Button, UnreadCount } from "../../src/components/Button"
import { Disclosure } from "../../src/components/Disclosure"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <main style={{ padding: "var(--space-24)", background: "var(--surface)", color: "var(--text)" }}>
      <h1>Componentes touri</h1>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-12)" }}>
        <Button variant="primary">Criar bot</Button>
        <Button variant="secondary">Cancelar</Button>
        <Button variant="quiet">Marcar como lida</Button>
        <Button variant="link-action">Abrir e revisar</Button>
        <Button variant="destructive">Excluir bot</Button>
      </div>
      <p>
        <Badge>Neutro</Badge> <Badge tone="info">Informação</Badge> <Badge tone="success">Concluído</Badge>{" "}
        <Badge tone="warning">Aprovação</Badge> <Badge tone="danger">Falhou</Badge> <UnreadCount count={12} />
      </p>
      <Disclosure animateContent summary="Detalhes técnicos">
        <Button variant="secondary">Ação nos detalhes</Button>
      </Disclosure>
      <Button variant="quiet">Depois dos detalhes</Button>
    </main>,
  )
