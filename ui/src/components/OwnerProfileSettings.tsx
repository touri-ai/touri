import type { OwnerProfile } from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import { t } from "../i18n"
import { AvatarPicker } from "./AvatarPicker"
import { Disclosure } from "./Disclosure"
import { PersonAvatar } from "./PersonAvatar"

export const OwnerProfileSettings = ({
  profile,
  accountName,
  onChange,
  focusName = false,
  onPendingChange,
}: {
  profile: OwnerProfile
  accountName?: string | undefined
  focusName?: boolean
  onChange: (profile: OwnerProfile) => void
  onPendingChange?: (pending: boolean) => void
}) => {
  const [source, setSource] = useState<ImageBitmap | null>(null)
  const [zoom, setZoom] = useState(1)
  const [horizontal, setHorizontal] = useState(50)
  const [vertical, setVertical] = useState(50)
  const [error, setError] = useState(false)
  const [encodingPhoto, setEncodingPhoto] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const latest = useRef({ profile, onChange, onPendingChange, source })
  latest.current = { profile, onChange, onPendingChange, source }
  const avatarBeforeCrop = useRef<OwnerProfile["avatar"]>(null)
  const pending = useRef({ reading: false, encoding: false })
  const setPhotoPending = useCallback((change: { reading?: boolean; encoding?: boolean }) => {
    pending.current = { ...pending.current, ...change }
    setEncodingPhoto(pending.current.encoding)
    latest.current.onPendingChange?.(pending.current.reading || pending.current.encoding)
  }, [])
  useEffect(
    () => () => {
      source?.close()
    },
    [source],
  )
  useEffect(
    () => () => {
      request.current += 1
      setPhotoPending({ reading: false, encoding: false })
    },
    [setPhotoPending],
  )
  useEffect(() => {
    const context = canvas.current?.getContext("2d")
    if (!source) return
    if (!context) {
      setError(true)
      setPhotoPending({ encoding: false })
      return
    }
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
    // Cancel callbacks from an earlier crop before they can replace the current draft.
    let active = true
    const photoRequest = request.current
    const reader = new FileReader()
    const fail = () => {
      if (!active) return
      if (photoRequest === request.current) setError(true)
      setPhotoPending({ encoding: false })
    }
    reader.onerror = fail
    reader.onload = () => {
      if (!active) return
      const dataUrl = reader.result
      if (typeof dataUrl !== "string" || dataUrl.length > 100_000) {
        fail()
        return
      }
      if (photoRequest === request.current) setError(false)
      latest.current.onChange({ ...latest.current.profile, avatar: { kind: "image", dataUrl } })
      setPhotoPending({ encoding: false })
    }
    setPhotoPending({ encoding: true })
    canvas.current?.toBlob(
      (blob) => {
        if (!active) return
        if (!blob) {
          fail()
          return
        }
        reader.readAsDataURL(blob)
      },
      "image/webp",
      0.85,
    )

    return () => {
      active = false
      reader.abort()
    }
  }, [source, zoom, horizontal, vertical, setPhotoPending])
  const upload = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const version = ++request.current
    setError(false)
    if (file.size > 5_000_000 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError(true)
      setPhotoPending({ reading: false })
      return
    }
    setPhotoPending({ reading: true })
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
      if (!latest.current.source) avatarBeforeCrop.current = latest.current.profile.avatar
      setPhotoPending({ reading: false, encoding: true })
      setSource(bitmap)
    } catch {
      if (version !== request.current) return
      setError(true)
      setPhotoPending({ reading: false })
    }
  }
  const mascot =
    profile.avatar?.kind === "mascot" ? profile.avatar : { avatarSeed: "owner", avatarShape: null, color: null }
  const displayName = profile.name.trim() || accountName || t("Você")
  const clearPhotoDraft = () => {
    request.current += 1
    setPhotoPending({ reading: false, encoding: false })
    setSource(null)
  }
  return (
    <div className="owner-profile-settings">
      <label htmlFor="owner-name">{t("Profile name")}</label>
      <input
        id="owner-name"
        data-initial-focus={focusName || undefined}
        value={profile.name}
        placeholder={accountName}
        maxLength={80}
        onChange={(event) => onChange({ ...profile, name: event.target.value })}
      />
      <div className="owner-profile-identity">
        <PersonAvatar
          person={{ id: "owner", avatarSeed: "owner", name: displayName }}
          avatar={profile.avatar}
          size={64}
        />
      </div>
      <Disclosure className="owner-profile-avatar" summary={t("Change avatar")} openWhen={Boolean(source || error)}>
        <input
          ref={photoInput}
          type="file"
          hidden
          aria-label={t("Upload profile photo")}
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            void upload(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        <div className="owner-profile-identity">
          <button type="button" className="button button-quiet" onClick={() => photoInput.current?.click()}>
            {t("Choose photo")}
          </button>
          {profile.avatar && (
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                clearPhotoDraft()
                onChange({ ...profile, avatar: null })
              }}
            >
              {t("Remove profile avatar")}
            </button>
          )}
        </div>
        <p className="owner-profile-hint">{t("Choose PNG, JPEG or WebP up to 5 MB.")}</p>
        {error && (
          <p className="owner-profile-error" role="alert">
            {t("Could not read the photo. Choose PNG, JPEG or WebP up to 5 MB.")}
          </p>
        )}
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
              disabled={error || encodingPhoto}
              onClick={clearPhotoDraft}
            >
              {t("Use cropped photo")}
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                clearPhotoDraft()
                onChange({ ...profile, avatar: avatarBeforeCrop.current })
              }}
            >
              {t("Cancel")}
            </button>
          </div>
        )}
        <AvatarPicker
          bot={{ id: "owner", ...mascot }}
          label={t("Create profile mascot")}
          onChange={(choice) => {
            clearPhotoDraft()
            onChange({ ...profile, avatar: { kind: "mascot", ...mascot, ...choice } })
          }}
        />
      </Disclosure>
    </div>
  )
}
