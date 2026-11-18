import { LoaderCircle, RefreshCw } from "lucide-react";

/**
 * One quiet line: "OpenAI models · From your account", then refresh (kept
 * discoverable even when the catalog is filtered or unavailable). The ⇧⌘M
 * hint lives in the model chip's tooltip, not here, so it never reads as part
 * of the source text (round 6, I14).
 */
export function ModelCatalogHeader({ provider, heading, description, loading, disabled, onRefresh }: {
  provider: string;
  heading: string;
  description: string;
  loading?: boolean;
  disabled?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <div className="model-catalog-heading openrouter-menu-meta model-menu-heading">
      <span className="model-catalog-title" title={`${heading} · ${description}`}>
        <span className="model-catalog-name">{heading}</span>
        <small className="model-catalog-source"><span aria-hidden="true"> · </span>{description}</small>
      </span>
      {onRefresh && <button
        type="button"
        className="model-meta-refresh"
        onClick={onRefresh}
        title={`Refresh ${provider} models`}
        aria-label={`Refresh ${provider} model catalog`}
        aria-busy={Boolean(loading)}
        disabled={loading || disabled}
      >
        {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
      </button>}
    </div>
  );
}
