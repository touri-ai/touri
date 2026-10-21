import { ChannelComposerChip } from "../features/channelBrowser/ChannelBrowser"
import type { Locale } from "../i18n"

export const BrowserWorkingStatus = ({
  name,
  botId,
  onStop,
  locale = "pt-BR",
}: {
  name: string
  botId?: string | undefined
  onStop?: (() => void) | undefined
  locale?: Locale
}) => <ChannelComposerChip botName={name} botId={botId} onStop={onStop} locale={locale} />
