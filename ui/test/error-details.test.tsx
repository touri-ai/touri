import { fireEvent, render, screen } from "@testing-library/react"
import { expect, test } from "vitest"
import { ErrorText } from "../src/components/ErrorDetails"

const cases = [
  { text: "network error: ECONNRESET [TOURI-E1009]", code: "TOURI-E1009", diagnostic: "ECONNRESET" },
  { text: "network error: ECONNRESET", code: "TOURI-E1009", diagnostic: "ECONNRESET" },
  { text: "Falha de conexão [TOURI-E1009]", code: "TOURI-E1009", diagnostic: "TOURI-E1009" },
  { text: "[TOURI-E1009] [TOURI-E1009]", code: "TOURI-E8001", diagnostic: "TOURI-E8001" },
]

test.each(cases)("one closed disclosure preserves diagnostics for $text", ({ text, code, diagnostic }) => {
  const { container } = render(<ErrorText text={text} code={code} />)
  const summary = screen.getByText("Detalhes do erro")
  const details = summary.closest("details")

  expect(container.querySelectorAll("details")).toHaveLength(1)
  expect(details).not.toHaveAttribute("open")
  expect(details?.querySelector("code")).toHaveTextContent(diagnostic)
  expect(details?.querySelector("code")).toHaveTextContent(code)
  expect(details?.querySelector("code")?.textContent?.match(/TOURI-E1009/g)).toHaveLength(1)

  fireEvent.click(summary)

  expect(details).toHaveAttribute("open")
  expect(details?.querySelector("code")).toBeVisible()
})

test("a plain explanation needs no diagnostic disclosure", () => {
  const { container } = render(<ErrorText text="Confira o computador e tente novamente." />)

  expect(screen.getByText("Confira o computador e tente novamente.")).toBeVisible()
  expect(container.querySelector("details")).toBeNull()
})

test("long diagnostics preserve every reference code within the size limit", () => {
  const text = `network error: ECONNRESET ${"Conexão de demonstração interrompida. ".repeat(30)} [TOURI-E1009]`

  const { container } = render(<ErrorText text={text} code="TOURI-E8001" />)
  const diagnostic = container.querySelector("code")?.textContent ?? ""

  expect(diagnostic).toContain("TOURI-E1009")
  expect(diagnostic).toContain("TOURI-E8001")
  expect(diagnostic).toContain("ECONNRESET")
  expect(diagnostic.match(/TOURI-E1009/g)).toHaveLength(1)
  expect(diagnostic.length).toBeLessThanOrEqual(240)
  expect(container.querySelectorAll("details")).toHaveLength(1)
})
