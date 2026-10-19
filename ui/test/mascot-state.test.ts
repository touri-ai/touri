import type { Message, MessagePart, NotificationRecord, Run } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import {
  MASCOT_DONE_MS,
  MascotMachine,
  type MascotState,
  mascotMoodFor,
  mascotSignalFor,
} from "../src/components/mascotState"
import { MascotHarness } from "./fixtures/mascotHarness"

const run = (status: Run["status"], patch: Partial<Run> = {}): Run => ({
  id: "r",
  botId: "b",
  threadId: "t",
  provider: "codex",
  trigger: "user",
  requestMessageId: "request",
  replyMessageId: "reply",
  externalTurnId: null,
  status,
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: 10,
  startedAt: 20,
  finishedAt: null,
  ...patch,
})
const message = (parts: MessagePart[], patch: Partial<Message> = {}): Message => ({
  id: "reply",
  threadId: "t",
  parentId: "request",
  role: "assistant",
  kind: "text",
  status: "streaming",
  runId: "r",
  text: "",
  parts,
  sender: null,
  source: "local",
  createdAt: 20,
  updatedAt: 30,
  ...patch,
})
const tool: MessagePart = {
  type: "tool_call",
  callId: "call",
  tool: "read",
  summary: "",
  inputJson: "{}",
  outputJson: null,
  ok: null,
}
const approval: MessagePart = { type: "approval", approvalId: "a", request: "command", detail: "", decision: "pending" }
const stateFor = (runs: Run[], messages: Message[] = [], notifications: NotificationRecord[] = []) =>
  mascotSignalFor({ botId: "b", runs, messages, notifications }).state

describe("runtime projection", () => {
  it("projects idle parking without hiding work or approval, and wakes deterministically", () => {
    const machine = {
      botId: "b",
      status: "stopped" as const,
      pauseReason: "inactivity" as const,
      progress: null,
      error: null,
      memoryMb: 1024,
      createdMs: 0,
      startMs: 0,
    }
    const parked = mascotSignalFor({ botId: "b", machine })
    const mascot = new MascotMachine(parked, 100)
    expect(mascot.snapshot.state).toBe("parked")
    const snapshot = mascot.snapshot
    expect(mascot.send({ type: "tick" }, 4000)).toBe(snapshot)
    expect(mascot.deadline).toBeNull()
    expect(mascotSignalFor({ botId: "b", machine, runs: [run("running")] }).state).toBe("thinking")
    expect(
      mascotSignalFor({ botId: "b", machine, runs: [run("running")], messages: [message([approval])] }).state,
    ).toBe("waiting-approval")
    mascot.send({ type: "composer", focused: true, typing: false }, 5000)
    expect(mascot.snapshot.state).toBe("parked")
    const awake = mascotSignalFor({ botId: "b", machine: { ...machine, status: "starting", pauseReason: null } })
    expect(mascot.send({ type: "runtime", signal: awake }, 6000)).toMatchObject({ state: "listening", since: 6000 })
  })
  it("distinguishes preparation, reasoning, text, pending tools and approval", () => {
    expect(stateFor([run("queued")])).toBe("thinking")
    expect(stateFor([run("starting")])).toBe("thinking")
    expect(stateFor([run("running")], [message([{ type: "reasoning", text: "análise" }])])).toBe("thinking")
    expect(stateFor([run("running")], [message([{ type: "text", text: "resposta" }])])).toBe("typing")
    expect(stateFor([run("running")], [message([tool])])).toBe("working-tool")
    expect(stateFor([run("running")], [message([tool, approval])])).toBe("waiting-approval")
    expect(stateFor([run("running")], [message([tool, { ...approval, decision: "approved" }])])).toBe("working-tool")
    expect(stateFor([run("running")], [message([{ ...tool, ok: true }])])).toBe("thinking")
    expect(
      stateFor(
        [run("running")],
        [message([{ type: "command", callId: "c", command: "ls", cwd: "/", outputTail: "", exitCode: null }])],
      ),
    ).toBe("working-tool")
  })
  it.each(["succeeded", "failed", "canceled", "interrupted"] as const)(
    "terminal %s stops stale streaming and approvals",
    (status) => {
      expect(stateFor([run(status)], [message([tool, approval])])).toBe(status === "failed" ? "error" : "idle")
    },
  )
  it("new work supersedes an old failure and unrelated bots cannot change state", () => {
    const old = run("failed", { id: "old", queuedAt: 1 })
    const note = { botId: "b", kind: "turn-failed", createdAt: 2, resolvedAt: null } as NotificationRecord
    expect(stateFor([old, run("running")], [], [note])).toBe("thinking")
    expect(stateFor([run("running", { botId: "other" })])).toBe("idle")
    expect(mascotSignalFor({ botId: "b", paused: true, runs: [run("running")] }).state).toBe("sleeping")
  })
  it("unresolved attention waits, and resolved attention resumes work", () => {
    const note = { botId: "b", kind: "approval", resolvedAt: null } as NotificationRecord
    expect(stateFor([run("running")], [], [note])).toBe("waiting-approval")
    expect(stateFor([run("running")], [], [{ ...note, resolvedAt: 42 }])).toBe("thinking")
  })
})

describe("state machine and deterministic harness", () => {
  it("transitions through seven product phases while preserving composer and tool detail", () => {
    const machine = new MascotMachine()
    const phases = [machine.snapshot.phase]
    for (const state of ["thinking", "working-tool", "waiting-approval", "error", "sleeping"] as const) {
      phases.push(machine.send({ type: "runtime", signal: { state, completion: null } }, phases.length).phase)
    }
    phases.push(machine.send({ type: "runtime", signal: { state: "idle", completion: "new:1" } }, 10).phase)
    expect(phases).toEqual(["idle", "thinking", "working", "waiting", "failed", "asleep", "done"])
    expect(machine.send({ type: "tick" }, 10 + MASCOT_DONE_MS).phase).toBe("idle")
    expect(machine.send({ type: "composer", focused: true, typing: false }, 3000)).toMatchObject({
      state: "listening",
      phase: "idle",
    })
    expect(machine.send({ type: "composer", focused: true, typing: true }, 3010)).toMatchObject({
      state: "typing",
      phase: "working",
    })
    expect(mascotMoodFor("working-tool")).toBe("working")
    expect(mascotMoodFor("error")).toBe("failed")
    expect(mascotMoodFor("parked")).toBe("asleep")
  })

  it("keeps an approval in charge across composer input, parking and completion", () => {
    const machine = new MascotMachine({ state: "waiting-approval", completion: null })
    machine.send({ type: "composer", focused: true, typing: true }, 10)
    machine.send({ type: "park", parked: true }, 20)
    const snapshot = machine.send({ type: "runtime", signal: { state: "waiting-approval", completion: "old:1" } }, 30)
    expect(snapshot).toMatchObject({ state: "waiting-approval", phase: "waiting", revision: 0 })
    expect(machine.send({ type: "tick" }, 10000)).toBe(snapshot)
    expect(machine.deadline).toBeNull()
    expect(machine.send({ type: "runtime", signal: { state: "working-tool", completion: "old:1" } }, 10010).phase).toBe(
      "working",
    )
  })
  it("replays all states, leaves snapshots stable on repeated input and freezes historical completions", () => {
    const harness = new MascotHarness()
    const visited = [harness.machine.snapshot.state]
    visited.push(harness.send({ type: "composer", focused: true, typing: false }, 10).state)
    visited.push(harness.send({ type: "composer", focused: true, typing: true }, 20).state)
    for (const state of ["thinking", "working-tool", "waiting-approval", "error", "sleeping"] as MascotState[])
      visited.push(harness.send({ type: "runtime", signal: { state, completion: null } }, harness.now + 10).state)
    harness.send({ type: "composer", focused: false, typing: false })
    visited.push(harness.send({ type: "runtime", signal: { state: "idle", completion: "r:1" } }, 100).state)
    expect(harness.frame(100 + MASCOT_DONE_MS).state).toBe("idle")
    visited.push(harness.send({ type: "park", parked: true }, 3000).state)
    expect(new Set(visited).size).toBe(10)
    const snapshot = harness.machine.snapshot
    expect(harness.send({ type: "tick" }, 3010)).toBe(snapshot)
    expect(new MascotMachine({ state: "idle", completion: "old" }).snapshot.state).toBe("idle")
  })
  it("completion replay does not extend the celebration, and retry interrupts it", () => {
    const machine = new MascotMachine()
    const signal = { state: "idle" as const, completion: "r:1" }
    machine.send({ type: "runtime", signal }, 100)
    machine.send({ type: "runtime", signal }, 2000)
    expect(machine.send({ type: "tick" }, 2500).state).toBe("idle")
    machine.send({ type: "runtime", signal: { ...signal, completion: "r:2" } }, 3000)
    expect(machine.snapshot.state).toBe("done")
    machine.send({ type: "runtime", signal: { state: "thinking", completion: "r:2" } }, 3100)
    expect(machine.snapshot.state).toBe("thinking")
    expect(machine.deadline).toBeNull()
  })
  it("holds a background completion until acknowledgement, and enforces monotonic time", () => {
    const machine = new MascotMachine()
    machine.send({ type: "runtime", signal: { state: "idle", completion: "r:1", holdDone: true } }, 10)
    expect(machine.send({ type: "tick" }, 60000).state).toBe("done")
    expect(machine.deadline).toBeNull()
    expect(
      machine.send({ type: "runtime", signal: { state: "idle", completion: "r:1", holdDone: false } }, 60001).state,
    ).toBe("idle")
    expect(machine.send({ type: "park", parked: true }, 1).since).toBe(60001)
  })
})
