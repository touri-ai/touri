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

  const play = (volume: number): void => {
    const audio = getContext()
    if (audio?.state !== "running" || volume <= 0) return

    const startedAt = audio.currentTime
    const tones = [
      { frequency: 880, gain: 0.16 },
      { frequency: 1174.66, gain: 0.08 },
    ]
    tones.forEach(({ frequency, gain: partialGain }) => {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = "sine"
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, startedAt)
      gain.gain.linearRampToValueAtTime(volume * partialGain, startedAt + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + 0.68)
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.start(startedAt)
      oscillator.stop(startedAt + 0.7)
    })
  }

  return { play, unlock }
}
