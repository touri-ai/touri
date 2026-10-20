import "../../../src/styles.css"
import "./avatars.css"
import type { AvatarLegacyShape, AvatarShape } from "@touri/contracts"
import { AVATAR_SHAPES, type AvatarIdentity, type AvatarMood } from "@touri/contracts/avatar"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { BotAvatar } from "../../../src/components/BotAvatar"

const MOODS: readonly AvatarMood[] = ["idle", "working", "waiting", "failed", "responded", "asleep", "connecting"]
const HEADS: readonly { shape: AvatarLegacyShape; label: string }[] = [
  { shape: "cercle", label: "Circle · cercle" },
  { shape: "galet", label: "Pebble · galet" },
  { shape: "squircle", label: "Squircle" },
  { shape: "capsule", label: "Pill / pilule · capsule" },
  { shape: "triangle", label: "Shield · triangle" },
  { shape: "hexagone", label: "Hexagon · hexagone" },
  { shape: "nuage", label: "Cloud · nuage" },
]
const SEEDS = Array.from({ length: 14 }, (_, index) => `shape-seed-${index}`)

const Fixture = () => {
  const [mood, setMood] = useState<AvatarMood>("idle")
  const [theme, setTheme] = useState(() => getFixtureTheme())
  const still = new URLSearchParams(window.location.search).has("still")
  const bot = getBot("classic-none")

  return (
    <main className="avatar-evidence" data-theme={theme}>
      <div className="avatar-evidence-controls">
        <label>
          Mood{" "}
          <select aria-label="Mood" value={mood} onChange={(event) => setMood(event.target.value as AvatarMood)}>
            {MOODS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Theme{" "}
          <select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value)}>
            <option value="dark">dark</option>
            <option value="light">light</option>
          </select>
        </label>
      </div>
      <article id="gallery">
        <h1>
          touri bull avatars · {mood} · {theme}
        </h1>
        <div className="avatar-evidence-sizes">
          {[24, 32, 40, 64].map((size) => (
            <div key={size} className="avatar-evidence-sample">
              <BotAvatar bot={bot} size={size} mood={mood} still={still} unread={size === 40} />
              <small>{size}px</small>
            </div>
          ))}
        </div>
        <section id="shape-gallery" aria-labelledby="shape-gallery-heading">
          <h2 id="shape-gallery-heading">Head shapes · same colour, horns and accessory</h2>
          <div className="avatar-evidence-heads">
            {HEADS.map(({ shape, label }) => (
              <figure key={shape} data-head={shape}>
                <div className="avatar-evidence-sizes">
                  {[24, 40, 64].map((size) => (
                    <div key={size} className="avatar-evidence-sample">
                      <BotAvatar bot={getBot(`${shape}:classic-none`)} size={size} mood={mood} still={still} />
                      <small>{size}px</small>
                    </div>
                  ))}
                </div>
                <figcaption>{label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
        <section aria-labelledby="seed-gallery-heading">
          <h2 id="seed-gallery-heading">Seeded heads · automatic silhouette</h2>
          <div className="avatar-evidence-seeds">
            {SEEDS.map((seed) => (
              <figure key={seed} data-seed={seed}>
                <BotAvatar bot={getBot("classic-none", seed)} size={40} mood={mood} still={still} />
                <figcaption>{seed}</figcaption>
              </figure>
            ))}
          </div>
        </section>
        <section aria-labelledby="look-gallery-heading">
          <h2 id="look-gallery-heading">Horns × accessories · same seeded head</h2>
          <div className="avatar-evidence-looks">
            {AVATAR_SHAPES.map((shape) => (
              <figure key={shape}>
                <BotAvatar bot={getBot(shape)} size={48} mood={mood} still={still} />
                <figcaption>{shape}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      </article>
    </main>
  )
}

const getBot = (avatarShape: AvatarShape, seed = "shape-gallery"): AvatarIdentity => ({
  id: seed,
  avatarSeed: seed,
  avatarShape,
  color: "#e8483f",
})

const getFixtureTheme = (): string => {
  if (new URLSearchParams(window.location.search).get("theme") === "light") return "light"

  return "dark"
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
