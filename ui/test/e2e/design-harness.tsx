import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "../../src/components/Button"
import { PageTransition } from "../../src/components/PageTransition"
import { AnimatedDisclosure, useReveal } from "../../src/components/Reveal"
import { navigatePage } from "../../src/design/navigation"
import { installMotionTokens } from "../../src/design/spring"
import type { AppRoute } from "../../src/workspaceState"
import "../../src/styles.css"

installMotionTokens(document.documentElement)

const Harness = () => {
  const [route, setRoute] = useState<AppRoute>({ section: "bots", screen: "chat" })
  const composerRef = useReveal<HTMLFormElement>()
  return (
    <main className="app-shell" style={{ padding: 24 }}>
      <div className="brand-button-samples">
        <Button className="button button-brand">Parear e continuar</Button>
        <button type="button" className="brand-button">
          Continuar
        </button>
      </div>
      <nav aria-label="Páginas de teste">
        <button
          type="button"
          className="button button-dark"
          onClick={() => navigatePage(route, { section: "bots", screen: "preview" }, setRoute)}
        >
          Abrir preview
        </button>
        <button
          type="button"
          className="button button-dark"
          onClick={() => navigatePage(route, { section: "bots", screen: "chat" }, setRoute)}
        >
          Voltar ao chat
        </button>
      </nav>
      <PageTransition route={route}>
        <section style={{ padding: 24 }}>
          <h1>{route.section === "bots" && route.screen === "chat" ? "Conversa" : "Preview"}</h1>
          <AnimatedDisclosure className="tool-card" summary="1 chamada de ferramenta">
            <p>Resultado disponível.</p>
            <button type="button" className="button button-dark">
              Expandir resultado
            </button>
          </AnimatedDisclosure>
          <form ref={composerRef} className="composer">
            <textarea aria-label="Mensagem de teste" placeholder="Escreva uma mensagem" />
          </form>
          <span className="run-spinner" aria-hidden="true">
            ◌
          </span>
          <span className="tb-typing" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </section>
      </PageTransition>
    </main>
  )
}

createRoot(document.getElementById("root") as HTMLElement).render(<Harness />)
