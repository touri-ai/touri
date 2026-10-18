import { DEMI_VIEWBOX, POSES } from "@norbert_bodziony/bloub"
import { convertFileSrc } from "@tauri-apps/api/core"
import type { Bot } from "@touri/contracts"
import {
  type AvatarIdentity,
  type AvatarMood,
  type AvatarMotion,
  avatarExpressionFor,
  avatarHasClock,
  avatarPresentation,
  avatarProfileFor,
  avatarViewBoxFor,
  createAvatarEngine,
} from "@touri/contracts/avatar"
import { type CSSProperties, useEffect, useId, useRef, useState } from "react"
import { t } from "../i18n"
import { useAvatarMood, useMascotSnapshot } from "./AvatarRuntime"
import { AvatarGaze, AvatarPlayback, attachAvatarGaze, paintAvatarFrame } from "./avatarMotion"
import { MascotChoreography } from "./mascotMotion"
import { type MascotState, mascotLabelFor, mascotMoodFor, mascotPhaseFor } from "./mascotState"
import { useReducedMotion } from "./useReducedMotion"

export type { AvatarShape } from "@touri/contracts"
export { avatarColorFor, avatarShapeFor } from "@touri/contracts/avatar"

const HOVER_CONTROL = "[data-avatar-hover],button,a,[role=button],[role=link],[role=menuitem]"
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
  cycleOffset = 0,
  animationOffset,
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
  followPointer?: boolean
  cycleOffset?: number
  animationOffset?: number
  url?: string | null
  unread?: boolean | number
  className?: string
}) => {
  const runtimeMood = useAvatarMood(bot, override)
  const snapshot = useMascotSnapshot(bot, threadId)
  const state = stateOverride ?? snapshot.state
  const mood = stateOverride || (threadId && !override) ? mascotMoodFor(state) : runtimeMood
  const runtimeMotion = override === undefined
  const reduced = useReducedMotion()
  const profile = avatarProfileFor(bot)
  const presentation = avatarPresentation(mood)
  const expression = avatarExpressionFor(profile, mood)
  const outline = presentation.outline
  const source = url === undefined ? photoSource(bot.avatarPath) : url
  const [failedSource, setFailedSource] = useState<string | null>(null)
  useEffect(() => {
    if (source !== null) setFailedSource(null)
  }, [source])
  const photo = Boolean(source && source !== failedSource)
  const [interacting, setInteracting] = useState(false)
  const host = useRef<HTMLSpanElement>(null)
  const body = useRef<SVGSVGElement>(null)
  const contour = useRef<SVGPathElement>(null)
  const playback = useRef<AvatarPlayback | null>(null)
  const gaze = useRef(new AvatarGaze())
  const choreography = useRef<MascotChoreography | null>(null)
  const playbackKey = useRef("")
  const id = useId().replace(/[^a-zA-Z0-9-]/g, "")
  const seed = bot.avatarSeed ?? bot.id
  const attentive = runtimeMotion && ["listening", "waiting-approval", "done"].includes(state)
  const resting = runtimeMotion && (state === "sleeping" || state === "parked")
  const animated =
    !still && !resting && avatarHasClock(mood, reduced, motion, interacting || attentive, followPointer && !photo)

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
    if (!element) return
    const key = `${seed}:${animated}:${interacting}:${photo}:${animationOffset}`
    if (playbackKey.current !== key) {
      playbackKey.current = key
      playback.current = null
      gaze.current = new AvatarGaze()
      choreography.current = new MascotChoreography(seed, state)
    }
    if (!choreography.current) choreography.current = new MascotChoreography(seed, state)
    choreography.current?.update(state)
    const choreographer = choreography.current
    const gesture =
      runtimeMotion && state !== "idle" && mood !== "connecting"
        ? (seconds: number) => choreographer.sample(seconds)
        : undefined
    const profileNow = { shape: profile.shape, color: profile.color, expression, phase: profile.phase }
    if (animated && !photo) {
      if (!playback.current)
        playback.current = new AvatarPlayback(
          profileNow,
          interacting && ["idle", "responded"].includes(mood) ? "idle" : mood,
          interacting ? 1 : cycleOffset,
          interacting ? 0 : animationOffset,
        )
      else
        playback.current.update(
          profileNow,
          interacting && ["idle", "responded"].includes(mood) ? "idle" : mood,
          interacting ? 1 : cycleOffset,
        )
    }
    const player = playback.current
    const tracker = !still && followPointer && !photo && !reduced ? attachAvatarGaze(element, gaze.current) : null
    const paintBody = (): void => {
      if (!body.current || photo) return
      const frame =
        animated && player
          ? player.engine.sample(player.time)
          : createAvatarEngine(profileNow, mood).sample(POSES[presentation.state])
      paintAvatarFrame(body.current, frame, profile.color, id)
      contour.current?.setAttribute("d", frame.bodyPath)
      element.dataset.avatarState = animated && player ? player.engine.state : presentation.state
    }
    paintBody()
    if (reduced || !animated) return () => tracker?.release()

    let frameId = 0
    let visible = true
    const tick = (now: number): void => {
      if (!element.isConnected) return
      frameId = requestAnimationFrame(tick)
      if (player && animated && player.advance(now, tracker?.sample, gesture)) paintBody()
    }
    const stop = (): void => {
      cancelAnimationFrame(frameId)
      frameId = 0
    }
    const sync = (): void => {
      if (!visible || document.hidden) {
        stop()
        return
      }
      if (frameId) return
      player?.resume()
      frameId = requestAnimationFrame(tick)
    }
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? true
            sync()
          })
        : null
    observer?.observe(element)
    document.addEventListener("visibilitychange", sync)
    sync()
    return () => {
      stop()
      observer?.disconnect()
      tracker?.release()
      document.removeEventListener("visibilitychange", sync)
    }
  }, [
    interacting,
    animated,
    photo,
    seed,
    profile.shape,
    profile.color,
    profile.phase,
    expression,
    mood,
    reduced,
    followPointer,
    cycleOffset,
    animationOffset,
    id,
    presentation.state,
    state,
    runtimeMotion,
    still,
  ])

  const viewBox = photo
    ? `${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`
    : avatarViewBoxFor(profile.shape)
  return (
    <span
      ref={host}
      className={`tb-avatar ${photo ? "tb-avatar-photo" : ""} ${className}`.trim()}
      style={{ width: size, height: size, "--avatar-color": profile.color } as CSSProperties}
      data-avatar={photo ? "image" : "generated"}
      data-avatar-shape={profile.shape}
      data-avatar-mood={mood}
      data-mascot-state={state}
      data-mascot-phase={mascotPhaseFor(state)}
      title={mascotLabelFor(state)}
      data-avatar-animated={animated}
      data-avatar-expression={expression}
      data-bot-id={bot.id}
      data-outline={outline ? "" : undefined}
    >
      {photo ? (
        <img src={source ?? ""} alt="" draggable={false} onError={() => setFailedSource(source ?? null)} />
      ) : (
        <svg
          ref={body}
          className="tb-avatar-body"
          width={100}
          height={100}
          viewBox={viewBox}
          aria-hidden="true"
          focusable="false"
        />
      )}
      {outline && (
        <svg className="tb-avatar-outline" viewBox={viewBox} aria-hidden="true" focusable="false">
          {photo ? (
            <circle className="tb-avatar-contour" cx="0" cy="0" r={DEMI_VIEWBOX / 1.28} />
          ) : (
            <path ref={contour} className="tb-avatar-contour" />
          )}
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
