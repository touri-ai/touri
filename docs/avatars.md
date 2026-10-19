# Bot avatars

Every bot is a bull from the same family as the touri mascot, drawn as vector shapes in the language of the earlier blob avatars: a smooth silhouette in the bot colour, an ink outline, light pill eyes and a pulsing glow while it works. A bot changes its colour, horns and accessory; each runtime state has its own face, effect and CSS animation. The drawing is original touri artwork in `packages/contracts/src/avatar.ts`; there is no rendering dependency.

## Identity

Use a saved avatar seed, otherwise the stable bot ID. Hash UTF-16 code units with unsigned 32-bit FNV-1a and select each part with its own suffix: `:horns` (classic, short, long, none), `:accessory` (none, ring, glasses, headphones, cap, flower, crown) and `:color` (rouge, orange, ambre, vert, turquoise, bleu, violet, rose). The blink offset is the unsigned seed hash divided by 2^32, multiplied by the 4.2-second blink cycle.

`avatarShape` stores the chosen look as `<horns>-<accessory>` (`short-flower`). The API still accepts the seven older silhouette ids (`cercle`, `galet`, `squircle`, `capsule`, `triangle`, `hexagone`, `nuage`; `goutte` stays invalid), and they render the seeded automatic look, so stored bots and groups need no migration. Bot settings only send `avatarShape` and `color` when the user changes them, and the group dialog sends a stored shape back untouched, so saving never rewrites an older id. Each new group dialog draws its look from its own random seed.

| Stored hue | Label | Engine color | Hex |
| --- | --- | --- | --- |
| 0 | Red | rouge | #e8483f |
| 30 | Orange | orange | #f08a24 |
| 55 | Yellow | ambre | #f0b429 |
| 100 | Lime | vert | #3ecf8e |
| 150 | Green | vert | #3ecf8e |
| 185 | Cyan | turquoise | #2fbfa0 |
| 215 | Blue | bleu | #3b93f0 |
| 245 | Indigo | violet | #8b5cf6 |
| 280 | Violet | violet | #8b5cf6 |
| 320 | Magenta | rose | #e152b0 |

Lime and Violet remain valid aliases but are omitted from the eight visible colour choices. The picker saves palette hex values through touri's existing API; Automatic saves null. Uncustomized old UI accent colors, including #ff8a3d, no longer override automatic identities. Existing explicit custom hex colors on picker identities are retained.

## Drawing

The bull keeps the proportions of the original 16 × 16 design as smooth paths in a 100-unit box: a wide flat forehead, horizontal ears with a light inside, a gold snout that forms the chin, white horns shaded grey at the base, and brows that carry its frown. Horns, ears and the snout outline are drawn for the left side and mirrored. An ink outline (the bot colour mixed toward near-black) sits under horns, ears and head, and under accessories that leave the face, so light horns, caps and headphones read on both themes. The yellow bull gets a paler snout.

Layers, in order: the aura (thinking and working only), ink outline, horns, ears, head, forehead tufts, snout, nostrils and brows; then the eyes; then the accessory; then the state effects.

## States and motion

| Phase | From mascot state | Face | Effect | Head motion |
| --- | --- | --- | --- | --- |
| idle | idle, listening | pill eyes, blinks | — | slow breath every 2.8 s |
| thinking | thinking, connecting | looking up, blinks | three dots light up in turn; aura pulses | gentle tilt every 2.4 s |
| working | typing, working-tool | lowered eyes and brows, blinks | steam from the nostrils; aura pulses | bob every 0.6 s |
| waiting | waiting-approval | round eyes, raised brows, blinks | blue "!" (#0a84ff) bouncing | bob every 1.6 s |
| done | done (2.4 s, or until focus returns) | happy arcs | two sparkles | hop every 1.4 s |
| failed | error | slanted eyes, sad brows | smoke and a falling tear | head shake every 2.6 s |
| asleep | sleeping, parked | closed | rising zZ | slow breath (preview only), muted opacity |

All movement is CSS keyframes, so active avatars never touch the DOM and need no frame loop; each bot's seed offsets its blink and breath (`--avatar-delay`) so neighbours never move together. Idle bulls only move while their closest control is hovered or focused, or with `motion="always"`; sleeping and parked bots hold still, while the customizer preview still shows the asleep motion. `still` and reduced motion (system or touri setting) show the static frame. Effects are hidden below 20px; there the eyes, brows, aura, the waiting/failed glow and the asleep opacity still tell the states apart.

With `followPointer` (the customizer preview) the eyes turn toward the pointer through two CSS variables, written at most once per animation frame without a React render.

Photo avatars keep their image with a circular outline while thinking or working; image errors fall back to the bull and a changed URL retries the image.

## Runtime states and activity

`MascotMachine` owns a stable snapshot for each bot and each conversation: idle, listening, typing, thinking, working-tool, waiting-approval, error, done, sleeping, or parked. The provider projects existing run, message, notification, computer-grant and composer events into these machines; no database state or schema change is needed. Bot snapshots aggregate their conversations, while the chat avatar and activity line observe the same conversation snapshot.

Paused bots sleep. Pending approvals, questions and takeovers take precedence over active work. Pending tool calls or commands show working-tool; the latest text/reasoning part distinguishes typing from thinking. Terminal runs suppress stale streaming parts and pending message approvals. New work takes precedence over historical failures. An idle, hidden conversation parks; active work retains its state while its animation clock stops.

Fresh completions celebrate for 2.4 seconds, including when the composer retains focus. A background bot reply remains done until window focus returns. Initial history establishes a baseline instead of celebrating past replies. Deadlines are scheduled separately from snapshots, so consecutive completions reschedule the timeout even when the displayed state stays done. All machine timestamps use an injected monotonic clock.

The activity mark beneath a streaming reply carries a pt-BR status phrase beside a still bull, alongside three activity dots. Waiting for approval removes the dots and can link to the pending approval. Reduced motion holds the dots still with readable status updates.

The deterministic harness is `ui/test/fixtures/mascotHarness.ts`; state and integration tests cover transitions, cancellation, history hydration, completion deadlines, visibility and reduced motion. `ui/test/e2e/fixtures/mascot-states.html` exposes all states for browser checks of identity, activity, motion and accessibility.

## Customizer

`AvatarPicker` previews the bull at 96px with a choice for every phase, a 32px sidebar row and a 16px chat pill when the bot has a name. Colour, horns, accessory and preview state are native radio groups; Shuffle picks a random full look and Restore automatic returns to the seeded look and automatic colour. Below 400px the picker switches to compact tiles.

## Verification

`ui/test/avatar-motion.test.tsx` covers identity, the drawing and motion rules; `ui/test/e2e/avatars.spec.ts` and `ui/test/e2e/mascot-state.spec.ts` check the animations, reduced motion and the absence of DOM writes in a headless browser.
