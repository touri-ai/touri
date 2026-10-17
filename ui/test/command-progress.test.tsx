import { act, cleanup, render, screen } from "@testing-library/react"
import type { CommandPart, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { ToolCallCard } from "../src/components/ToolCallCard"

const command: CommandPart = {
  type: "command",
  callId: "shell",
  command: "bun test",
  cwd: "/workspace",
  outputTail: "step 1\n",
  exitCode: null,
  startedAt: 1_000,
  outputMode: "streaming",
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it("shows a live tail and elapsed time before completion, including the newest long-output lines", () => {
  vi.useFakeTimers()
  vi.setSystemTime(8_000)
  const view = render(<ToolCallCard part={command} />)
  expect(screen.getByText("step 1")).toBeVisible()
  expect(screen.getByLabelText("Tempo de execução")).toHaveTextContent("7 s")
  act(() => vi.advanceTimersByTime(7_000))
  expect(screen.getByLabelText("Tempo de execução")).toHaveTextContent("14 s")
  view.rerender(<ToolCallCard part={{ ...command, outputTail: `${"old line\n".repeat(200)}step 2\n` }} />)
  expect(screen.getByText(/step 2/)).toBeVisible()
  expect(screen.queryByText("Sem saída")).toBeNull()
  view.rerender(<ToolCallCard part={{ ...command, exitCode: 0 }} />)
  expect(screen.queryByLabelText("Tempo de execução")).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(["Bash", "PowerShell"])("explains end-only output for %s and replaces the hint when output arrives", (tool) => {
  const part: ToolCallPart = {
    type: "tool_call",
    callId: "shell",
    tool,
    summary: "Run checks",
    inputJson: '{"command":"bun test"}',
    outputJson: null,
    ok: null,
    outputMode: "on_completion",
    startedAt: 1_000,
  }
  const view = render(<ToolCallCard part={part} />)
  expect(screen.getByText("A saída aparece quando o comando terminar.")).toBeVisible()
  expect(screen.queryByText("Sem saída")).toBeNull()
  view.rerender(<ToolCallCard part={{ ...part, outputMode: "streaming", outputTail: "step 1\n" }} />)
  expect(screen.getByText("step 1")).toBeVisible()
  expect(screen.queryByText("A saída aparece quando o comando terminar.")).toBeNull()
  view.rerender(<ToolCallCard part={{ ...part, ok: true, outputJson: "done" }} />)
  expect(screen.queryByText("A saída aparece quando o comando terminar.")).toBeNull()
})

it("shows a waiting message for a streaming command before its first output", () => {
  render(<ToolCallCard part={{ ...command, outputTail: "" }} />)
  expect(screen.getByText("Aguardando saída do comando…")).toBeVisible()
  expect(screen.queryByText("Sem saída")).toBeNull()
})
