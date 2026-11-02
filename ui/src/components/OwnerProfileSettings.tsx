import type { OwnerProfile } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import { t } from "../i18n"
import { AvatarPicker } from "./AvatarPicker"
import { PersonAvatar } from "./PersonAvatar"

export const OwnerProfileSettings = ({
  profile,
  onChange,
  focusName = false,
}: {
  profile: OwnerProfile
  focusName?: boolean
  onChange: (profile: OwnerProfile) => void
}) => {
  const [source, setSource] = useState<ImageBitmap | null>(null)
  const [zoom, setZoom] = useState(1)
  const [horizontal, setHorizontal] = useState(50)
  const [vertical, setVertical] = useState(50)
  const [error, setError] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const request = useRef(0)
  useEffect(
    () => () => {
      source?.close()
    },
    [source],
  )
  useEffect(
    () => () => {
      request.current += 1
    },
    [],
  )
  useEffect(() => {
    const context = canvas.current?.getContext("2d")
    if (!source || !context) return
    const side = Math.min(source.width, source.height) / zoom
    context.clearRect(0, 0, 256, 256)
    context.drawImage(
      source,
      ((source.width - side) * horizontal) / 100,
      ((source.height - side) * vertical) / 100,
      side,
      side,
      0,
      0,
      256,
      256,
    )
  }, [source, zoom, horizontal, vertical])
  const upload = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const version = ++request.current
    setError(false)
    if (file.size > 5_000_000 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError(true)
      return
    }
    try {
      const original = await createImageBitmap(file)
      const scale = Math.min(1, 1024 / Math.max(original.width, original.height))
      const bitmap = await createImageBitmap(original, {
        resizeWidth: Math.max(1, Math.round(original.width * scale)),
        resizeHeight: Math.max(1, Math.round(original.height * scale)),
        resizeQuality: "high",
      }).finally(() => original.close())
      if (version !== request.current) {
        bitmap.close()
        return
      }
      setZoom(1)
      setHorizontal(50)
      setVertical(50)
      setSource(bitmap)
    } catch {
      if (version === request.current) setError(true)
    }
  }
  const mascot =
    profile.avatar?.kind === "mascot" ? profile.avatar : { avatarSeed: "owner", avatarShape: null, color: null }
  return (
    <div className="owner-profile-settings">
      <label htmlFor="owner-name">{t("Profile name")}</label>
      <input
        id="owner-name"
        data-initial-focus={focusName || undefined}
        value={profile.name}
        maxLength={80}
        onChange={(event) => onChange({ ...profile, name: event.target.value })}
      />
      <PersonAvatar
        person={{ id: "owner", avatarSeed: "owner", name: profile.name || t("Você") }}
        avatar={profile.avatar}
        size={64}
      />
      <label htmlFor="owner-photo">{t("Upload profile photo")}</label>
      <input
        id="owner-photo"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          void upload(event.target.files?.[0])
          event.target.value = ""
        }}
      />
      <p>{t("Choose PNG, JPEG or WebP up to 5 MB.")}</p>
      {error && <p role="alert">{t("Could not read the photo. Choose PNG, JPEG or WebP up to 5 MB.")}</p>}
      {source && (
        <div>
          <canvas ref={canvas} width={256} height={256} aria-label={t("Photo crop preview")} />
          <label>
            {t("Zoom")}
            <input
              type="range"
              min="1"
              max="3"
              step="0.05"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>
          <label>
            {t("Horizontal position")}
            <input
              type="range"
              min="0"
              max="100"
              value={horizontal}
              onChange={(event) => setHorizontal(Number(event.target.value))}
            />
          </label>
          <label>
            {t("Vertical position")}
            <input
              type="range"
              min="0"
              max="100"
              value={vertical}
              onChange={(event) => setVertical(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              const dataUrl = canvas.current?.toDataURL("image/webp", 0.85)
              if (!dataUrl || dataUrl.length > 100_000) {
                setError(true)
                return
              }
              onChange({ ...profile, avatar: { kind: "image", dataUrl } })
              setSource(null)
            }}
          >
            {t("Use cropped photo")}
          </button>
          <button type="button" className="button button-quiet" onClick={() => setSource(null)}>
            {t("Cancel")}
          </button>
        </div>
      )}
      <AvatarPicker
        bot={{ id: "owner", ...mascot }}
        label={t("Create profile mascot")}
        onChange={(choice) => {
          request.current += 1
          setSource(null)
          onChange({ ...profile, avatar: { kind: "mascot", ...mascot, ...choice } })
        }}
      />
      <button
        type="button"
        className="button button-quiet"
        disabled={!profile.avatar}
        onClick={() => {
          request.current += 1
          setSource(null)
          onChange({ ...profile, avatar: null })
        }}
      >
        {t("Remove profile avatar")}
      </button>
    </div>
  )
}
