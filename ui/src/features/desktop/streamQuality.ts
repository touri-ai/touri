type QualitySample = { bytes: number; startedAt: number; changedAt: number; quality: number }

export const getInitialQuality = (at: number): QualitySample => ({ bytes: 0, startedAt: at, changedAt: at, quality: 6 })

/** Only sustained traffic is evidence of capacity; an idle screen is not a slow link. */
export const getStreamQuality = (sample: QualitySample, bytes: number, at: number): QualitySample => {
  const received = sample.bytes + bytes
  const elapsed = at - sample.startedAt
  if (elapsed < 2_000) return { ...sample, bytes: received }
  const mbps = (received * 8) / (elapsed * 1_000)
  const reset = { ...sample, bytes: 0, startedAt: at }
  if (received < 262_144 || at - sample.changedAt < 6_000) return reset
  if (sample.quality === 6 && mbps > 8) return { ...reset, quality: 8, changedAt: at }
  if (sample.quality === 8 && mbps < 4) return { ...reset, quality: 6, changedAt: at }

  return reset
}
