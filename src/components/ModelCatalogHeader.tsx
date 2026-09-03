import { LoaderCircle, RefreshCw } from "lucide-react";

/** Keep refresh discoverable even when the catalog is filtered or unavailable. */
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
      <span title={heading}>{heading}</span>
      <small title={description}>{description}</small>
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
