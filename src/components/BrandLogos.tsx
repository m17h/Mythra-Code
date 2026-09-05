import type { Provider } from "../types";

/**
 * Official provider wordless marks, loaded from one local SVG sprite. Claude stays white
 * inside its orange brand tile in every theme; OpenAI stays white inside its
 * dark tile. OpenRouter uses its official wordless brand glyph.
 */

type LogoProps = { size?: number; className?: string };

function ProviderMark({ size = 16, className, mark, viewBox, fill }: LogoProps & { mark: string; viewBox: string; fill: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox={viewBox} fill={fill} aria-hidden="true" focusable="false">
      <use href={`/provider-marks.svg#${mark}`} />
    </svg>
  );
}

function BrandImage({ size = 16, className, src }: LogoProps & { src: string }) {
  return <img className={className} width={size} height={size} src={src} alt="" aria-hidden="true" draggable={false} />;
}

/** Official OpenRouter v2 glyph from https://openrouter.ai/brand. */
export function OpenRouterLogo(props: LogoProps) {
  return <ProviderMark {...props} mark="openrouter" viewBox="0 0 401.4 293.7" fill="currentColor" />;
}

/** Official LM Studio color app icon from LM Studio's public brand kit. */
export function LmStudioLogo(props: LogoProps) {
  return <BrandImage {...props} src="/lm-studio-icon.svg" />;
}

export function ClaudeLogo(props: LogoProps) {
  return <ProviderMark {...props} mark="claude" viewBox="0 0 24 24" fill="#fff" />;
}

export function AnthropicLogo(props: LogoProps) {
  return <ProviderMark {...props} mark="anthropic" viewBox="0 0 24 24" fill="currentColor" />;
}

export function ClaudeProviderLogo({ size = 16, className }: LogoProps) {
  return (
    <span className={`claude-logo-choice${className ? ` ${className}` : ""}`} style={{ width: size, height: size }}>
      <ClaudeLogo size={size} className="claude-logo-option" />
      <AnthropicLogo size={size} className="anthropic-logo-option" />
    </span>
  );
}

export function OpenAILogo(props: LogoProps) {
  return <ProviderMark {...props} mark="openai" viewBox="0 0 24 24" fill="#fff" />;
}

/** Compact vector interpretation of the official Codex terminal-cloud mark. */
export function CodexLogo(props: LogoProps) {
  // Keep gradient paint servers in the same SVG document for native WebKit.
  return <BrandImage {...props} src="/codex-icon.svg" />;
}

/** Official Cursor 2D cube mark from Cursor's public brand kit. */
export function CursorLogo(props: LogoProps) {
  return <ProviderMark {...props} mark="cursor" viewBox="0 0 466.73 532.09" fill="currentColor" />;
}

/** Official Cursor 2.5D dark app icon from Cursor's downloadable brand kit. */
export function CursorDarkAppIcon(props: LogoProps) {
  return <BrandImage {...props} src="/cursor-app-icon-dark.png" />;
}

export function CursorProviderLogo({ size = 16, className }: LogoProps) {
  return (
    <span className={`cursor-logo-choice${className ? ` ${className}` : ""}`} style={{ width: size, height: size }}>
      <CursorLogo size={size} className="cursor-cube-logo-option" />
      <CursorDarkAppIcon size={size} className="cursor-dark-logo-option" />
    </span>
  );
}

export function ProviderLogo({ provider, size = 16, className }: LogoProps & { provider: Provider }) {
  if (provider === "lmstudio") return <LmStudioLogo size={size} className={className} />;
  if (provider === "cursor") return <CursorProviderLogo size={size} className={className} />;
  if (provider === "claude") return <ClaudeProviderLogo size={size} className={className} />;
  if (provider === "openrouter") return <OpenRouterLogo size={size} className={className} />;
  if (provider === "openai") {
    return (
      <span className={`openai-logo-choice${className ? ` ${className}` : ""}`} style={{ width: size, height: size }}>
        <OpenAILogo size={size} className="openai-logo-option" />
        <CodexLogo size={size} className="codex-logo-option" />
      </span>
    );
  }
  return null;
}
