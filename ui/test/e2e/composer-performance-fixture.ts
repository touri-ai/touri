import type { Message, MessagePart } from "@touri/contracts"

export const composerPerformanceMessageCount = 500
export const composerPerformanceToolCount = 3_000

/** Deterministic synthetic history. This fixture never reads an existing conversation. */
export const createComposerPerformanceMessages = (
  threadId = "composer-performance-thread",
  messageCount = composerPerformanceMessageCount,
): Message[] => {
  const start = Date.UTC(2026, 0, 1)
  return Array.from({ length: messageCount }, (_, index) => {
    const assistant = index % 2 === 1
    const turn = Math.floor(index / 2)
    const text = assistant
      ? `## Synthetic review ${turn + 1}\n\nReviewed **sample ${turn + 1}** using generated data.\n\n- [x] Inspect the sample\n- [x] Record the result\n- [ ] Review the next sample\n\n| Item | Result |\n| --- | --- |\n| Sample ${turn + 1} | Complete |\n\nThe next step is to review another generated sample.`
      : `Review generated sample ${turn + 1} and summarize its result.`
    const parts: MessagePart[] = [{ type: "text", text }]
    if (assistant) {
      for (let tool = 0; tool < 12; tool++) {
        parts.push({
          type: "tool_call",
          callId: `composer-performance-call-${turn}-${tool}`,
          tool: "read_file",
          summary: `Read generated sample ${turn + 1}.${tool + 1}`,
          inputJson: JSON.stringify({ path: `/workspace/synthetic/sample-${turn}-${tool}.md` }),
          outputJson: JSON.stringify({
            lines: ["Generated sample", "Status: complete", "No source conversation data", "Ready for review"],
          }),
          ok: true,
        })
      }
    }
    return {
      id: `composer-performance-message-${index}`,
      threadId,
      parentId: index ? `composer-performance-message-${index - 1}` : null,
      role: assistant ? "assistant" : "user",
      kind: "text",
      status: "complete",
      runId: assistant ? `composer-performance-run-${turn}` : null,
      text,
      parts,
      sender: null,
      source: "local",
      createdAt: start + index * 60_000,
      updatedAt: start + index * 60_000,
    }
  })
}
