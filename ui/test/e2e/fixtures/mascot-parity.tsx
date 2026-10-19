import "../../../src/styles.css"
import "./mascot-parity.css"
import type { AvatarMood } from "@touri/contracts/avatar"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { BotAvatar } from "../../../src/components/BotAvatar"

const seeds = ["mark", "onb", "Panko", "seo", "qa-bot", "review"]
const moods: AvatarMood[] = ["idle", "working", "waiting", "failed", "responded", "connecting", "asleep"]
const sizes = [24, 32, 40]
const Fixture = () => {
  const [live, setLive] = useState(new URLSearchParams(location.search).has("live"))
  return (
    <>
      <div id="controls">
        <button type="button" onClick={() => setLive(!live)}>
          Toggle montage
        </button>
      </div>
      <article id="gallery">
        <div className="parity-grid">
          <div className="parity-heading">Seed / px</div>
          {moods.map((mood) => (
            <div className="parity-heading" key={mood}>
              {mood}
            </div>
          ))}
          {seeds.map((seed) => (
            <Row key={seed} seed={seed} live={live} />
          ))}
        </div>
      </article>
      <button id="hover-probe" type="button" style={{ margin: 32 }}>
        <BotAvatar bot={{ id: "mark", color: null }} size={40} />
      </button>
    </>
  )
}
const Row = ({ seed, live }: { seed: string; live: boolean }) => (
  <>
    <div className="parity-seed">{seed}</div>
    {moods.map((mood) => (
      <div key={mood} className="parity-cell" data-seed={seed} data-mood={mood}>
        {sizes.map((size) => (
          <div className="parity-size" key={size}>
            <BotAvatar bot={{ id: seed, color: null }} size={size} mood={mood} motion={live ? "always" : "hover"} />
            <small>{size}</small>
          </div>
        ))}
      </div>
    ))}
  </>
)
const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
