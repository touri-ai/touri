import { type Locale } from "../i18n"
import { ChannelComposerChip } from "../features/channelBrowser/ChannelBrowser"

export const BrowserWorkingStatus = ({
  name,
  onStop,
  locale = "pt-BR",
}: {
  name: string
  onStop?: (() => void) | undefined
  locale?: Locale
}) => <ChannelComposerChip botName={name} onStop={onStop} locale={locale} />
