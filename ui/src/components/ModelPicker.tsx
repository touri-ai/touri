import { getApiModelReference, type Provider } from "@touri/contracts"
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { getBotModelName, getBotProviderName, PROVIDER_MODELS, providerName } from "./ProviderMark"
import "./ModelPicker.css"

type ModelOption = { value: string | null; label: string }
type ListItem = { kind: "model"; value: string | null; label: string } | { kind: "other"; label: string }

const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const MODEL_OPTION_HEIGHT = 40
const MODEL_WINDOW_SIZE = 20
const MODEL_OVERSCAN = 4

const isVisibleModelName = (value: string): boolean =>
  value.length > 0 && value.length <= 256 && !value.startsWith("-") && !HIDDEN_CHARACTERS.test(value)

export const ModelPicker = ({
  api,
  botId,
  provider,
  value,
  onSave,
  onChange,
  onBusyChange,
  onNotice,
  id,
  descriptionId,
  className = "",
  showProvider = false,
  align = "start",
  direction = "down",
}: {
  api?: UiApi | undefined
  botId?: string | undefined
  provider: Provider
  value: string | null
  onSave: (model: string | null) => Promise<void>
  onChange?: (model: string) => void
  onBusyChange?: (busy: boolean) => void
  onNotice: (message: string) => void
  id?: string
  descriptionId?: string
  className?: string
  showProvider?: boolean
  align?: "start" | "end"
  direction?: "up" | "down"
}) => {
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const customInputRef = useRef<HTMLInputElement>(null)
  const pendingFocusRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customValue, setCustomValue] = useState("")
  const [customError, setCustomError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [discoveredModels, setDiscoveredModels] = useState<ModelOption[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState("")
  const getOptions = (): Array<ModelOption> => {
    const choices =
      provider === "opencode"
        ? discoveredModels
        : PROVIDER_MODELS[provider].map((model) => ({ value: model.id, label: model.label }))
    if (!value || choices.some((option) => option.value === value)) return choices

    return [{ value, label: getBotModelName({ model: value, provider }) }, ...choices]
  }

  const options: Array<ModelOption> = useMemo(getOptions, [discoveredModels, provider, value])
  const defaultOption: ModelOption = useMemo(
    () => ({
      value: null,
      label: defaultModel ? `${t("Padrão do provedor")} · ${defaultModel}` : t("Padrão do provedor"),
    }),
    [defaultModel],
  )
  const modelOptions: Array<ModelOption> = useMemo(() => {
    if (!value || options.some((option) => option.value === value)) return [defaultOption].concat(options)

    return [defaultOption, { value, label: getBotModelName({ model: value, provider }) }].concat(options)
  }, [defaultOption, options, provider, value])
  const selectedIndex = useMemo(
    () =>
      Math.max(
        0,
        modelOptions.findIndex((option) => option.value === value),
      ),
    [modelOptions, value],
  )
  const listItems: Array<ListItem> = useMemo(
    () => [
      ...modelOptions.map((option) => ({ kind: "model" as const, ...option })),
      { kind: "other", label: t("Other model…") },
    ],
    [modelOptions],
  )
  const isVirtualized = listItems.length > MODEL_WINDOW_SIZE
  const windowStart = isVirtualized ? Math.max(0, Math.floor(scrollTop / MODEL_OPTION_HEIGHT) - MODEL_OVERSCAN) : 0
  const windowEnd = isVirtualized ? Math.min(listItems.length, windowStart + MODEL_WINDOW_SIZE) : listItems.length
  const visibleItems = listItems.slice(windowStart, windowEnd)
  const modelName = getBotModelName({ model: value, provider })
  const providerLabel = getBotProviderName({ provider, model: value })
  const selection = showProvider ? `${providerLabel} · ${modelName}` : modelName

  useEffect(() => {
    if (!open || provider !== "opencode") return

    const lifecycle = new AbortController()
    const load = async (): Promise<void> => {
      setLoading(true)
      setLoadError("")
      setDiscoveredModels([])
      setDefaultModel(null)
      if (!api) {
        setLoadError(t("Could not load models. Use the default or enter a provider/model ID manually."))
        setLoading(false)
        return
      }

      const [providerResult, apiResult] = await Promise.allSettled([
        api.request("GET /providers/opencode/models", botId ? { botId } : {}),
        api.request("GET /api-models", {}),
      ])
      if (lifecycle.signal.aborted) return

      const providerModels =
        providerResult.status === "fulfilled"
          ? providerResult.value.models.map((model) => ({ value: model, label: model }))
          : []
      const apiModels =
        apiResult.status === "fulfilled"
          ? apiResult.value.models.map((model) => ({
              value: getApiModelReference(model),
              label: `${model.name} · ${model.modelId}`,
            }))
          : []
      const providerModelValues = new Set(providerModels.map((model) => model.value))
      setDiscoveredModels([...providerModels, ...apiModels.filter((model) => !providerModelValues.has(model.value))])
      setDefaultModel(providerResult.status === "fulfilled" ? providerResult.value.defaultModel : null)
      if (providerResult.status === "rejected") {
        if (!apiModels.length)
          setLoadError(t("Could not list models. Use the default or enter a provider/model ID manually."))
      } else if (!providerResult.value.available) {
        setLoadError(t("OpenCode is unavailable. Install OpenCode and check Doctor; you can enter a model manually."))
      } else if (!providerModels.length && !apiModels.length) {
        setLoadError(t("OpenCode returned no models. Use the default or enter a provider/model ID."))
      } else if (apiResult.status === "rejected") {
        setLoadError(t("Could not load models. Use the default or enter a provider/model ID manually."))
      }
      setLoading(false)
    }

    void load()
    return () => lifecycle.abort()
  }, [api, botId, open, provider])

  useEffect(() => {
    if (!open) return

    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false)
        setCustomOpen(false)
        setScrollTop(0)
        pendingFocusRef.current = null
      }
    }
    document.addEventListener("pointerdown", closeOutside)
    return () => document.removeEventListener("pointerdown", closeOutside)
  }, [open])

  useEffect(() => {
    if (!open) return
    if (customOpen) {
      customInputRef.current?.focus()
      return
    }
    if (isVirtualized && listboxRef.current) {
      const nextScrollTop = Math.max(0, selectedIndex * MODEL_OPTION_HEIGHT - MODEL_OPTION_HEIGHT * 2)
      listboxRef.current.scrollTop = nextScrollTop
      setScrollTop(nextScrollTop)
    }
    const selectedOption = optionRefs.current[selectedIndex]
    if (selectedOption) selectedOption.focus()
    else pendingFocusRef.current = selectedIndex
  }, [customOpen, isVirtualized, open, selectedIndex])

  useEffect(() => {
    if (!open || customOpen) return
    const pendingFocus = pendingFocusRef.current
    if (pendingFocus === null) return
    const option = optionRefs.current[pendingFocus]
    if (!option) return
    option.focus()
    pendingFocusRef.current = null
  })

  const close = (): void => {
    setOpen(false)
    setCustomOpen(false)
    setCustomError(false)
    setScrollTop(0)
    pendingFocusRef.current = null
    triggerRef.current?.focus()
  }

  const focusItem = (index: number): void => {
    setActiveIndex(index)
    pendingFocusRef.current = index
    const listbox = listboxRef.current
    if (isVirtualized && listbox) {
      const itemTop = index * MODEL_OPTION_HEIGHT
      const itemBottom = itemTop + MODEL_OPTION_HEIGHT
      const viewportTop = listbox.scrollTop
      const viewportBottom = viewportTop + listbox.clientHeight
      const nextScrollTop =
        itemTop < viewportTop ? itemTop : itemBottom > viewportBottom ? itemBottom - listbox.clientHeight : viewportTop
      if (nextScrollTop !== viewportTop) {
        listbox.scrollTop = nextScrollTop
        setScrollTop(nextScrollTop)
      }
    }
    const option = optionRefs.current[index]
    if (!option) return
    option.focus()
    pendingFocusRef.current = null
  }

  const openOther = (): void => {
    setCustomValue("")
    setCustomError(false)
    setCustomOpen(true)
  }

  const commit = async (next: string | null): Promise<void> => {
    if (saving) return
    const previous = value
    setSaving(true)
    onBusyChange?.(true)
    setCustomError(false)
    onChange?.(next ?? "")
    try {
      await onSave(next)
      setOpen(false)
      setCustomOpen(false)
      triggerRef.current?.focus()
    } catch (error) {
      onChange?.(previous ?? "")
      onNotice(t("Could not save model: {error}", { error: userFacingError(error) }))
    } finally {
      setSaving(false)
      onBusyChange?.(false)
    }
  }

  const commitCustom = (): void => {
    const model = customValue.trim()
    if (!isVisibleModelName(model) || customValue.length > 256 || HIDDEN_CHARACTERS.test(customValue)) {
      setCustomError(true)
      return
    }
    void commit(model)
  }

  const handleListKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const nextIndex = (index + (event.key === "ArrowDown" ? 1 : listItems.length - 1)) % listItems.length
      focusItem(nextIndex)
      return
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      focusItem(event.key === "Home" ? 0 : listItems.length - 1)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== "Enter" && event.key !== " ") return

    event.preventDefault()
    const item = listItems[index]
    if (item?.kind === "other") openOther()
    if (item?.kind === "model") void commit(item.value)
  }

  const handleCustomKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== "Enter") return

    event.preventDefault()
    commitCustom()
  }

  return (
    <div
      className={`model-picker-anchor model-picker-align-${align} model-picker-direction-${direction}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`model-picker-trigger ${className}`.trim()}
        aria-label={t("Choose model with selection", { selection: `${providerLabel} · ${modelName}` })}
        aria-describedby={descriptionId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        title={t("Bot model sentence", { provider: providerLabel, model: modelName })}
        disabled={saving}
        onClick={() => {
          if (open) {
            setOpen(false)
            setCustomOpen(false)
            setScrollTop(0)
            pendingFocusRef.current = null
            return
          }
          setActiveIndex(selectedIndex)
          setScrollTop(0)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
          event.preventDefault()
          setScrollTop(0)
          setOpen(true)
          setCustomOpen(false)
          setActiveIndex(selectedIndex)
        }}
      >
        <span className={`model-picker-trigger-label ${className === "composer-model" ? "composer-model-name" : ""}`}>
          {selection}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="model-picker-popover" data-escape-boundary>
          <div
            className="model-picker-options"
            id={menuId}
            ref={listboxRef}
            role="listbox"
            aria-label={t("Models for {provider}", { provider: providerName(provider) })}
            aria-busy={loading || saving}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            {isVirtualized && (
              <div
                className="model-picker-spacer"
                aria-hidden="true"
                style={{ height: windowStart * MODEL_OPTION_HEIGHT }}
              />
            )}
            {visibleItems.map((item, visibleIndex) => {
              const index = windowStart + visibleIndex
              if (item.kind === "other")
                return (
                  <button
                    key="other"
                    ref={(element) => {
                      optionRefs.current[index] = element
                    }}
                    type="button"
                    role="option"
                    aria-selected="false"
                    aria-setsize={listItems.length}
                    aria-posinset={index + 1}
                    tabIndex={activeIndex === index ? 0 : -1}
                    className="model-picker-option model-picker-other"
                    disabled={saving}
                    onFocus={() => setActiveIndex(index)}
                    onClick={openOther}
                    onKeyDown={(event) => handleListKeyDown(event, index)}
                  >
                    <span>{item.label}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                )

              const selected = item.value === value
              return (
                <button
                  key={item.value ?? "provider-default"}
                  ref={(element) => {
                    optionRefs.current[index] = element
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-setsize={listItems.length}
                  aria-posinset={index + 1}
                  tabIndex={activeIndex === index ? 0 : -1}
                  className="model-picker-option"
                  disabled={saving}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => void commit(item.value)}
                  onKeyDown={(event) => handleListKeyDown(event, index)}
                >
                  <span>{item.label}</span>
                  {selected && (
                    <span className="model-picker-current" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              )
            })}
            {isVirtualized && (
              <div
                className="model-picker-spacer"
                aria-hidden="true"
                style={{ height: (listItems.length - windowEnd) * MODEL_OPTION_HEIGHT }}
              />
            )}
          </div>
          {customOpen && (
            <div className="model-picker-custom">
              <input
                ref={customInputRef}
                type="text"
                aria-label={t("Model name")}
                aria-invalid={customError}
                aria-describedby={customError ? `${menuId}-custom-error` : undefined}
                placeholder={t("Model name")}
                value={customValue}
                maxLength={200}
                disabled={saving}
                onChange={(event) => {
                  setCustomValue(event.target.value)
                  setCustomError(false)
                }}
                onKeyDown={handleCustomKeyDown}
              />
              {customError && (
                <small id={`${menuId}-custom-error`} role="alert">
                  {t(
                    "Use a model name of up to 256 characters, without hidden or control characters or a leading dash.",
                  )}
                </small>
              )}
              {loadError && <small role="status">{loadError}</small>}
              <button
                type="button"
                className="button button-brand"
                disabled={saving || !isVisibleModelName(customValue.trim())}
                onClick={commitCustom}
              >
                {t("Use model")}
              </button>
            </div>
          )}
          {!customOpen && (loading || loadError) && (
            <small className="model-picker-status" role="status">
              {loading ? t("Loading models…") : loadError}
            </small>
          )}
        </div>
      )}
    </div>
  )
}
