import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { MarkdownContent } from "../src/components/MarkdownContent"

vi.mock("react-markdown", () => Promise.withResolvers<{ default: () => null }>().promise)

afterEach(cleanup)

it("shows bounded plain text while the Markdown renderer is still loading", () => {
  const content =
    "### Plano\n\n| Tarefa | Prazo |\n| --- | --- |\n| Revisar | Amanhã |\n\n**Conclusão:** " +
    "Texto fictício. ".repeat(1000)

  const view = render(<MarkdownContent content={content} />)
  const fallback = view.container.querySelector(".whitespace-pre-wrap")

  expect(fallback).toHaveTextContent("Plano")
  expect(fallback?.textContent).not.toMatch(/###|\*\*|\|/)
  expect(fallback?.textContent?.length).toBeLessThanOrEqual(620)
  expect(view.container.querySelector("table")).toBeNull()
})
