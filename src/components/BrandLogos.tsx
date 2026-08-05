import { useId } from "react";
import { Route } from "lucide-react";
import type { Provider } from "../types";

/**
 * Official provider wordless marks, drawn as inline paths. Claude stays white
 * inside its orange brand tile in every theme; OpenAI stays white inside its
 * dark tile. OpenRouter uses the same routing mark as its model control.
 */

type LogoProps = { size?: number; className?: string };

export function ClaudeLogo({ size = 16, className }: LogoProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="#fff"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.709 15.955l4.72-2.647.079-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.914-1.316-.012.006z" />
    </svg>
  );
}

export function AnthropicLogo({ size = 16, className }: LogoProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48z" />
      <path d="M6.569 3.52h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.674 20H0L6.569 3.52zm4.132 9.959L8.453 7.687 6.205 13.48h4.496z" />
    </svg>
  );
}

export function ClaudeProviderLogo({ size = 16, className }: LogoProps) {
  return (
    <span className={`claude-logo-choice${className ? ` ${className}` : ""}`} style={{ width: size, height: size }}>
      <ClaudeLogo size={size} className="claude-logo-option" />
      <AnthropicLogo size={size} className="anthropic-logo-option" />
    </span>
  );
}

export function OpenAILogo({ size = 16, className }: LogoProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="#fff"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.4066-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

/** Compact vector interpretation of the official Codex terminal-cloud mark. */
export function CodexLogo({ size = 16, className }: LogoProps) {
  const gradientId = `codex-gradient-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="6" y1="3" x2="17" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#b9a7ff" />
          <stop offset=".48" stopColor="#668cff" />
          <stop offset="1" stopColor="#3326ff" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M11.9 1.7c1.72 0 3.27.82 4.25 2.14 1.68-.2 3.39.62 4.24 2.08.83 1.43.77 3.2-.05 4.55 1.33 1.1 1.93 2.9 1.43 4.55-.5 1.61-1.96 2.8-3.6 3.03-.55 1.67-2.02 2.9-3.76 3.12-1.6.2-3.14-.42-4.13-1.55-1.42.85-3.25.86-4.68-.02-1.42-.88-2.22-2.48-2.09-4.08-1.53-.6-2.65-2.05-2.8-3.72-.15-1.64.66-3.23 1.98-4.15-.47-1.61.04-3.38 1.3-4.49 1.27-1.12 3.05-1.4 4.54-.79a5.27 5.27 0 0 1 3.37-1.2Z"
      />
      <path d="m7.8 8.1 2.55 3.9-2.55 3.9M12.55 15.9h4.1" fill="none" stroke="#fff" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Official Cursor 2D cube mark from Cursor's public brand kit. */
export function CursorLogo({ size = 16, className }: LogoProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 466.73 532.09" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M457.43 125.94 244.42 2.96c-6.84-3.95-15.28-3.95-22.12 0L9.3 125.94C3.55 129.26 0 135.4 0 142.05v247.99c0 6.65 3.55 12.79 9.3 16.11l213.01 122.98c6.84 3.95 15.28 3.95 22.12 0l213.01-122.98c5.75-3.32 9.3-9.46 9.3-16.11V142.05c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05 151.99 238.42 508.15c-1.39 2.4-5.06 1.42-5.06-1.36V273.58c0-4.66-2.49-8.97-6.53-11.31L24.87 145.67c-2.4-1.39-1.42-5.06 1.36-5.06h411.26c5.84 0 9.49 6.33 6.57 11.39h-.01Z" />
    </svg>
  );
}

/** Official Cursor 2.5D dark app icon from Cursor's downloadable brand kit. */
export function CursorDarkAppIcon({ size = 16, className }: LogoProps) {
  return (
    <img
      className={className}
      width={size}
      height={size}
      src="/cursor-app-icon-dark.png"
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
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
  if (provider === "cursor") return <CursorProviderLogo size={size} className={className} />;
  if (provider === "claude") return <ClaudeProviderLogo size={size} className={className} />;
  if (provider === "openai") {
    return (
      <span className={`openai-logo-choice${className ? ` ${className}` : ""}`} style={{ width: size, height: size }}>
        <OpenAILogo size={size} className="openai-logo-option" />
        <CodexLogo size={size} className="codex-logo-option" />
      </span>
    );
  }
  return <Route size={size} className={className} />;
}
