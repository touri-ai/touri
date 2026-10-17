import { t } from "../i18n"
import "./ConnectDataCard.css"

// Only an explicit final-line hint requests this card; ordinary limitations are not setup requests.
export const connectDataMarker = /(?:^|\n)<!-- touri:connect-data -->\s*$/

export const ConnectDataCard = ({
  onAttach,
  onFolder,
  onCatalog,
  desktop = false,
}: {
  onAttach: () => void
  onFolder?: (() => void) | undefined
  desktop?: boolean
  onCatalog: () => void
}) => (
  <section className="connect-data-card" aria-label={t("Conectar dados")}>
    <strong>{t("Conectar dados")}</strong>
    <p>{t("Escolha como disponibilizar os dados para este bot.")}</p>
    <div className="connect-data-actions">
      <button type="button" className="button button-quiet" onClick={onAttach}>
        {t("Enviar arquivo deste dispositivo")}
      </button>
      {onFolder && (
        <button type="button" className="button button-quiet" onClick={onFolder}>
          {desktop ? t("Escolher pasta") : t("Escolher pasta do servidor")}
        </button>
      )}
      <button type="button" className="button button-quiet" onClick={onCatalog}>
        {t("Adicionar ferramenta do catálogo")}
      </button>
    </div>
  </section>
)
