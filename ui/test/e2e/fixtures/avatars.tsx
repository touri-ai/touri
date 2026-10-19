import "../../../src/styles.css"
import type { Bot, NotificationRecord, Run, Thread } from "@touri/contracts"
import { AVATAR_SHAPES, type AvatarMood } from "@touri/contracts/avatar"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { AvatarRuntimeProvider } from "../../../src/components/AvatarRuntime"
import { BotAvatar } from "../../../src/components/BotAvatar"

const MOODS: AvatarMood[] = ["idle", "working", "waiting", "failed", "responded", "asleep", "connecting"]
const Fixture = () => {
  const [mood, setMood] = useState<AvatarMood>("idle")
  const bot = {
    id: "evidence",
    name: "touri",
    color: null,
    avatarSeed: "touri-evidence",
    paused: mood === "asleep",
  } as Bot
  const run: Run = {
    id: "run",
    botId: bot.id,
    threadId: "thread",
    provider: "codex",
    trigger: "user",
    requestMessageId: null,
    replyMessageId: "reply",
    externalTurnId: null,
    status: mood === "failed" ? "failed" : mood === "working" ? "running" : "succeeded",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: Date.now(),
  }
  const notification = { id: 1, botId: bot.id, kind: "question", resolvedAt: null } as NotificationRecord
  return (
    <>
      <label>
        Mood{" "}
        <select aria-label="Mood" value={mood} onChange={(event) => setMood(event.target.value as AvatarMood)}>
          {MOODS.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <AvatarRuntimeProvider
        value={{
          bots: [bot],
          runs: ["working", "failed", "responded"].includes(mood) ? [run] : [],
          threads: [{ id: "thread", botId: bot.id } as Thread],
          messages: [],
          notifications: mood === "waiting" ? [notification] : [],
          loading: mood === "connecting",
        }}
      >
        <article
          id="gallery"
          style={{ width: 600, padding: 24, background: "#242426", color: "#eee", fontFamily: "sans-serif" }}
        >
          <h1 style={{ margin: "0 0 20px", fontSize: 20 }}>touri · {mood}</h1>
          <div style={{ display: "flex", gap: 24, alignItems: "center", marginBottom: 28 }}>
            {[24, 32, 40, 64].map((size) => (
              <div key={size} style={{ display: "grid", gap: 8, justifyItems: "center" }}>
                <BotAvatar bot={bot} size={size} mood={mood} unread={size === 40} />
                <small>{size}px</small>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {AVATAR_SHAPES.map((shape) => (
              <BotAvatar key={shape} bot={{ ...bot, avatarShape: shape }} size={64} mood={mood} />
            ))}
          </div>
        </article>
      </AvatarRuntimeProvider>
    </>
  )
}
const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
