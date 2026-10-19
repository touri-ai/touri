import { convertFileSrc } from "@tauri-apps/api/core"
import type { Bot } from "@touri/contracts"
import {
  AVATAR_AURA_WIDTH,
  AVATAR_VIEWBOX,
  type AvatarIdentity,
  type AvatarMood,
  type AvatarMotion,
  type AvatarPath,
  type AvatarPhase,
  avatarBullFor,
  avatarPhaseForMood,
  avatarProfileFor,
} from "@touri/contracts/avatar"
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react"
import { t } from "../i18n"
import { useAvatarMood, useMascotSnapshot } from "./AvatarRuntime"
import { type MascotState, mascotLabelFor, mascotMoodFor, mascotPhaseFor } from "./mascotState"
import { useReducedMotion } from "./useReducedMotion"
import "./bot-avatar.css"

export type { AvatarShape } from "@touri/contracts"
export { avatarColorFor, avatarShapeFor } from "@touri/contracts/avatar"

const HOVER_CONTROL = "[data-avatar-hover],button,a,[role=button],[role=link],[role=menuitem]"
// Below this size the effects (dots, "!", zZ) turn into noise next to the face.
const EFFECTS_MIN_SIZE = 20
const photoSource = (path?: string | null): string | null => {
  if (!path) return null
  if (/^(https?:|data:|blob:|asset:)/.test(path)) return path
  return "__TAURI_INTERNALS__" in window ? convertFileSrc(path) : path
}

export const BotAvatar = ({
  bot,
  size = 32,
  mood: override,
  state: stateOverride,
  threadId,
  motion = "hover",
  still = false,
  followPointer = false,
  url,
  unread = false,
  className = "",
}: {
  bot: AvatarIdentity & Pick<Partial<Bot>, "name" | "paused">
  size?: number
  mood?: AvatarMood
  state?: MascotState
  threadId?: string
  motion?: AvatarMotion
  still?: boolean
  /** Eyes follow the pointer, as in the customizer preview. */
  followPointer?: boolean
  url?: string | null
  unread?: boolean | number
  className?: string
}) => {
  const runtimeMood = useAvatarMood(bot, override)
  const snapshot = useMascotSnapshot(bot, threadId)
  const state = stateOverride ?? snapshot.state
  const fromState = Boolean(stateOverride || (threadId && !override))
  const mood = fromState ? mascotMoodFor(state) : runtimeMood
  const phase = getAvatarPhase({ fromState, override, mood, state })
  const reduced = useReducedMotion()
  const profile = avatarProfileFor(bot)
  const source = url === undefined ? photoSource(bot.avatarPath) : url
  const [failedSource, setFailedSource] = useState<string | null>(null)
  useEffect(() => {
    if (source !== null) setFailedSource(null)
  }, [source])
  const photo = Boolean(source && source !== failedSource)
  const [interacting, setInteracting] = useState(false)
  const host = useRef<HTMLSpanElement>(null)
  const runtimeMotion = override === undefined
  const listening = runtimeMotion && state === "listening"
  // Sleeping and parked bots hold still, like the blob avatars did; previews still show the asleep motion.
  const resting = runtimeMotion && (state === "sleeping" || state === "parked")
  const animated =
    !still && !reduced && !resting && (phase !== "idle" || motion === "always" || interacting || listening)
  const gazing = followPointer && !still && !reduced && !photo

  useEffect(() => {
    const element = host.current
    if (!element) return
    const candidate = element.closest<HTMLElement>(`${HOVER_CONTROL},[tabindex]`)
    const target = candidate?.matches(HOVER_CONTROL) ? candidate : element
    const enter = (): void => setInteracting(true)
    const exit = (): void => setInteracting(false)
    const blur = (event: FocusEvent): void => {
      if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget)) exit()
    }
    target.addEventListener("pointerenter", enter)
    target.addEventListener("pointerleave", exit)
    target.addEventListener("focusin", enter)
    target.addEventListener("focusout", blur)
    return () => {
      target.removeEventListener("pointerenter", enter)
      target.removeEventListener("pointerleave", exit)
      target.removeEventListener("focusin", enter)
      target.removeEventListener("focusout", blur)
    }
  }, [])

  useEffect(() => {
    const element = host.current
    if (!element || !gazing) return
    return followGaze(element)
  }, [gazing])

  return (
    <span
      ref={host}
      className={`tb-avatar ${photo ? "tb-avatar-photo" : ""} ${className}`.trim()}
      style={
        {
          width: size,
          height: size,
          "--avatar-color": profile.color,
          "--avatar-delay": `-${profile.offset.toFixed(2)}s`,
        } as CSSProperties
      }
      data-avatar={photo ? "image" : "generated"}
      data-avatar-shape={profile.shape}
      data-avatar-mood={mood}
      data-avatar-phase={phase}
      data-mascot-state={state}
      data-mascot-phase={mascotPhaseFor(state)}
      title={mascotLabelFor(state)}
      data-avatar-animated={animated}
      data-bot-id={bot.id}
    >
      {photo ? (
        <img src={source ?? ""} alt="" draggable={false} onError={() => setFailedSource(source ?? null)} />
      ) : (
        <Bull
          color={profile.color}
          horns={profile.horns}
          accessory={profile.accessory}
          phase={phase}
          effects={size >= EFFECTS_MIN_SIZE}
        />
      )}
      {photo && (phase === "thinking" || phase === "working") && (
        <svg className="tb-avatar-outline" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">
          <circle className="tb-avatar-contour" cx="0" cy="0" r={39} />
        </svg>
      )}
      {Boolean(unread) && (
        <span className="tb-bang" title={t("Avatar unread")} aria-hidden="true">
          {typeof unread === "number" ? unread : 1}
        </span>
      )}
    </span>
  )
}

const Bull = ({
  color,
  horns,
  accessory,
  phase,
  effects,
}: Pick<ReturnType<typeof avatarProfileFor>, "color" | "horns" | "accessory"> & {
  phase: AvatarPhase
  effects: boolean
}) => {
  const bull = useMemo(() => avatarBullFor({ color, horns, accessory }, phase), [color, horns, accessory, phase])
  return (
    <svg
      className="tb-avatar-body"
      viewBox={AVATAR_VIEWBOX}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-blink={bull.blink ? "" : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {bull.aura && (
        <g className="tb-avatar-aura">
          {bull.silhouette.map((d) => (
            <path key={d} d={d} fill={bull.color} stroke={bull.color} strokeWidth={AVATAR_AURA_WIDTH} />
          ))}
        </g>
      )}
      <g className="tb-avatar-head">
        <BullPaths paths={bull.body} head={bull.head} />
        <g className="tb-avatar-gaze">
          <g className="tb-avatar-eyes" data-avatar-eyes="">
            <BullPaths paths={bull.eyes} />
          </g>
        </g>
        <BullPaths paths={bull.accessory} />
      </g>
      {effects &&
        bull.effects.map((effect) => (
          <g key={effect.id} className={`tb-avatar-fx tb-avatar-fx-${effect.id}`}>
            <BullPaths paths={effect.paths} />
          </g>
        ))}
    </svg>
  )
}

// Outlines reuse the fill geometry; width keeps those layers distinct across colour changes.
const BullPaths = ({ paths, head }: { paths: AvatarPath[]; head?: string }) =>
  paths.map((path) => (
    <path
      key={`${path.d}:${path.width ?? "fill"}`}
      d={path.d}
      fill={path.fill}
      stroke={path.stroke}
      strokeWidth={path.width}
      data-avatar-body={path.d === head && !path.stroke ? "" : undefined}
    />
  ))

/** Points the eyes toward the pointer through CSS variables, at most once per frame and without re-rendering. */
const followGaze = (element: HTMLElement): (() => void) => {
  let frame = 0
  let pointer = { x: 0, y: 0 }
  const paint = (): void => {
    frame = 0
    const box = element.getBoundingClientRect()
    const x = pointer.x - (box.left + box.width / 2)
    const y = pointer.y - (box.top + box.height / 2)
    const distance = Math.max(1, Math.hypot(x, y))
    const reach = Math.min(1, distance / 160) * GAZE_REACH
    element.style.setProperty("--avatar-gaze-x", `${((x / distance) * reach).toFixed(2)}px`)
    element.style.setProperty("--avatar-gaze-y", `${((y / distance) * reach).toFixed(2)}px`)
  }
  const move = (event: PointerEvent): void => {
    pointer = { x: event.clientX, y: event.clientY }
    if (!frame) frame = requestAnimationFrame(paint)
  }
  window.addEventListener("pointermove", move, { passive: true })

  return () => {
    window.removeEventListener("pointermove", move)
    cancelAnimationFrame(frame)
    element.style.removeProperty("--avatar-gaze-x")
    element.style.removeProperty("--avatar-gaze-y")
  }
}
// Viewbox units the eyes travel at most; they stay inside the face.
const GAZE_REACH = 4

const getAvatarPhase = ({
  fromState,
  override,
  mood,
  state,
}: {
  fromState: boolean
  override: AvatarMood | undefined
  mood: AvatarMood
  state: MascotState
}): AvatarPhase => {
  if (fromState) return mascotPhaseFor(state)
  if (override || mood === "connecting") return avatarPhaseForMood(mood)

  return mascotPhaseFor(state)
}
