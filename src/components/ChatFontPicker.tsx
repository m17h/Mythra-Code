import { useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { FileUp, Plus, Trash2, Type } from "lucide-react";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import {
  addInstalledCustomFont,
  chatFontCss,
  customChatFontId,
  customFontFor,
  importCustomFontFile,
  isFontInstalled,
  removeCustomFont,
  useCustomFontFaces,
  useCustomFonts,
  type CustomChatFont,
} from "../lib/customFonts";
import type { BuiltInChatFont, ChatFont } from "../types";
import "./ChatFontPicker.css";

/**
 * Built-in chat fonts. The stacks live in styles.css (--chat-font-<id>);
 * keep ids in sync with sanitizeChatFont. Pixelify Sans and VT323 are
 * bundled from Fontsource (SIL Open Font License).
 */
export const CHAT_FONTS: ReadonlyArray<{ id: BuiltInChatFont; name: string; description: string }> = [
  { id: "system", name: "Interface default", description: "The same typeface as the rest of Mythra Code" },
  { id: "humanist", name: "Humanist sans", description: "Open, warm letterforms with a little more air" },
  { id: "serif", name: "Reading serif", description: "Book-like text for long answers" },
  { id: "mono", name: "Monospace", description: "Fixed-width throughout, like a terminal" },
  { id: "pixelify", name: "Pixelify Sans", description: "Friendly pixel-art letters" },
  { id: "vt323", name: "VT323", description: "A classic glass-terminal look" },
];

function sample(css: string) {
  return <span className="chat-font-sample" style={{ fontFamily: css }} aria-hidden="true">Ag</span>;
}

/** Dropdown options for every chat font: built-ins, then the custom library. */
export function chatFontOptions(library: CustomChatFont[]): AppSelectOption[] {
  return [
    ...CHAT_FONTS.map((font) => ({ value: font.id, label: font.name, detail: font.description, icon: sample(`var(--chat-font-${font.id})`) })),
    ...library.map((font) => ({
      value: customChatFontId(font),
      label: font.name,
      detail: font.source === "file" ? "Custom font from a file" : "Installed on this computer",
      icon: sample(chatFontCss(customChatFontId(font), library)),
    })),
  ];
}

export function chatFontName(chatFont: ChatFont, library: CustomChatFont[]): string {
  return CHAT_FONTS.find((font) => font.id === chatFont)?.name ?? customFontFor(chatFont, library)?.name ?? "Interface default";
}

/** Settings > Interface: the chat font dropdown and the custom font library. */
export function ChatFontSettings({ value, onChange, active = true }: { value: ChatFont; onChange: (font: ChatFont) => void; active?: boolean }) {
  const library = useCustomFonts();
  useCustomFontFaces(library, active);
  const [busy, setBusy] = useState<"file" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [installedDraft, setInstalledDraft] = useState<string | null>(null);
  const operationRef = useRef(false);
  const sessionRef = useRef(0);
  const activeRef = useRef(active);
  const selectionRef = useRef({ value, onChange });
  const installedButtonRef = useRef<HTMLButtonElement>(null);
  const fileButtonRef = useRef<HTMLButtonElement>(null);
  activeRef.current = active;
  selectionRef.current = { value, onChange };
  // Settings stays mounted while closed. An operation may finish adding to
  // the library, but must never select into a closed or reopened draft.
  useEffect(() => {
    sessionRef.current += 1;
    if (!active) {
      setInstalledDraft(null);
      setError("");
    }
    return () => { sessionRef.current += 1; };
  }, [active]);
  const ownsSession = (session: number) => activeRef.current && sessionRef.current === session;
  const cancelInstalled = () => {
    const session = sessionRef.current;
    setInstalledDraft(null);
    setError("");
    requestAnimationFrame(() => {
      if (ownsSession(session)) installedButtonRef.current?.focus();
    });
  };
  // A custom font removed elsewhere shows as the interface default.
  const current = value.startsWith("custom:") && !customFontFor(value, library) ? "system" : value;

  const addFile = async () => {
    if (!activeRef.current || operationRef.current) return;
    operationRef.current = true;
    const session = sessionRef.current;
    const initialValue = selectionRef.current.value;
    setBusy("file");
    setError("");
    try {
      const path = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Choose a font file",
        filters: [{ name: "Fonts", extensions: ["ttf", "otf", "woff", "woff2"] }],
      });
      if (typeof path !== "string" || !ownsSession(session)) return;
      const font = await importCustomFontFile(path);
      if (ownsSession(session) && selectionRef.current.value === initialValue) {
        selectionRef.current.onChange(customChatFontId(font));
      }
    } catch (reason) {
      if (ownsSession(session)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  const addInstalled = () => {
    if (!activeRef.current || operationRef.current) return;
    const name = installedDraft?.trim() ?? "";
    setError("");
    if (!name) return;
    try {
      if (!isFontInstalled(name)) {
        setError(`Mythra Code can't find a font called "${name}" on this computer. Check the exact name in your system's font manager.`);
        return;
      }
      const font = addInstalledCustomFont(name);
      cancelInstalled();
      onChange(customChatFontId(font));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const remove = async (font: CustomChatFont, button: HTMLButtonElement) => {
    if (!activeRef.current || operationRef.current) return;
    operationRef.current = true;
    const session = sessionRef.current;
    setBusy("remove");
    setError("");
    try {
      await removeCustomFont(font.id);
      if (ownsSession(session)) {
        if (selectionRef.current.value === customChatFontId(font)) selectionRef.current.onChange("system");
        if (document.activeElement === button || (!button.isConnected && document.activeElement === document.body)) {
          requestAnimationFrame(() => {
            if (ownsSession(session)) fileButtonRef.current?.focus();
          });
        }
      }
    } catch (reason) {
      if (ownsSession(session)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  return (
    <div className="set-card chat-font-settings">
      <div className="set-row">
        <div className="set-copy">
          <strong>Chat font</strong>
          <small>Conversation text and the composer only. The rest of the interface keeps its own type, and code stays monospaced.</small>
        </div>
        <div className="set-control">
          <AppSelectMenu
            value={current}
            options={chatFontOptions(library)}
            ariaLabel="Chat font"
            portal
            onChange={(next) => onChange(next as ChatFont)}
          />
        </div>
      </div>
      <div className="set-row chat-font-library">
        <div className="set-copy">
          <strong>Custom fonts</strong>
          <small>Add a font file (.ttf, .otf, .woff or .woff2), or use a font already installed on this computer. Library additions and removals are saved immediately; Save applies your font selection.</small>
        </div>
        <div className="set-control chat-font-actions">
          <button ref={fileButtonRef} type="button" className="secondary-button" disabled={!!busy} onClick={() => void addFile()}>
            <FileUp size={13} /> {busy === "file" ? "Adding…" : "Add font file"}
          </button>
          <button ref={installedButtonRef} type="button" className="secondary-button" disabled={!!busy || installedDraft !== null} onClick={() => { setError(""); setInstalledDraft(""); }}>
            <Type size={13} /> Use installed font
          </button>
        </div>
        {installedDraft !== null && (
          <form className="chat-font-installed" onSubmit={(event) => { event.preventDefault(); addInstalled(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelInstalled(); } }}>
            <input
              autoFocus
              value={installedDraft}
              placeholder="Font name, for example JetBrains Mono"
              aria-label="Installed font name"
              spellCheck={false}
              onChange={(event) => setInstalledDraft(event.target.value)}
            />
            <button type="submit" className="secondary-button" disabled={!!busy || !installedDraft.trim()}><Plus size={13} /> Add</button>
            <button type="button" className="secondary-button" onClick={cancelInstalled}>Cancel</button>
          </form>
        )}
        {error && <p className="chat-font-error" role="alert">{error}</p>}
        {library.length > 0 && (
          <ul className="chat-font-list" aria-label="Custom fonts">
            {library.map((font) => (
              <li key={font.id}>
                {sample(chatFontCss(customChatFontId(font), library))}
                <span className="chat-font-list-copy">
                  <strong>{font.name}</strong>
                  <small>{font.source === "file" ? "From a font file" : "Installed on this computer"}</small>
                </span>
                <button type="button" className="icon-button" disabled={!!busy} aria-label={`Remove ${font.name}`} title="Remove this font" onClick={(event) => void remove(font, event.currentTarget)}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
