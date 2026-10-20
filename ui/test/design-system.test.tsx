import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { Badge, Button, type ButtonVariant, UnreadCount } from "../src/components/Button"

afterEach(cleanup)

it.each(["primary", "secondary", "quiet", "link-action", "destructive"] as const)(
  "renders the shared %s button variant",
  (variant: ButtonVariant) => {
    render(<Button variant={variant}>Ação</Button>)

    expect(screen.getByRole("button", { name: "Ação" })).toHaveClass(`ds-button-${variant}`)
  },
)

it("renders a state badge and hides an empty unread counter", () => {
  const { container } = render(
    <>
      <Badge tone="warning">Aguardando</Badge>
      <UnreadCount count={0} />
      <UnreadCount count={14} />
    </>,
  )

  expect(screen.getByText("Aguardando")).toHaveClass("ds-badge-warning")
  expect(screen.queryByText("0")).toBeNull()
  expect(screen.getByText("9+")).toHaveClass("ds-count")
  expect(container.querySelectorAll(".ds-count")).toHaveLength(1)
})
