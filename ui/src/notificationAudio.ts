import type { NotificationSoundKind } from "./notificationSound"

export const createBellAudioSink = () => {
  // AudioContext is created only after a user gesture, satisfying browser autoplay rules.
  let context: AudioContext | null = null

  const getContext = (): AudioContext | null => {
    if (typeof window === "undefined" || !("AudioContext" in window)) return null
    if (context) return context

    context = new window.AudioContext()
    return context
  }

  const unlock = (): void => {
    const audio = getContext()
    if (audio?.state === "suspended") void audio.resume().catch(() => undefined)
  }

  const play = (volume: number, kind?: NotificationSoundKind): void => {
    const audio = getContext()
    if (audio?.state !== "running" || volume <= 0) return

    const startedAt = audio.currentTime
    // A finished channel task is two soft rising notes within about 150 ms.
    const tones =
      kind === "channel"
        ? [
            { frequency: 783.99, gain: 0.07, at: 0, length: 0.07 },
            { frequency: 1046.5, gain: 0.06, at: 0.07, length: 0.08 },
          ]
        : kind === "task"
          ? [{ frequency: 659.25, gain: 0.06, at: 0, length: 0.7 }]
          : [
              { frequency: 880, gain: 0.16, at: 0, length: 0.7 },
              { frequency: 1174.66, gain: 0.08, at: 0, length: 0.7 },
            ]
    tones.forEach(({ frequency, gain: partialGain, at, length }) => {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      const start = startedAt + at
      oscillator.type = "sine"
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.linearRampToValueAtTime(volume * partialGain, start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length - 0.02)
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.start(start)
      oscillator.stop(start + length)
    })
  }

  return { play, unlock }
}
