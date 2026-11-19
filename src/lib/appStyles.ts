// Every global stylesheet the app draws with, in cascade order. The app
// (startApplication) and the hidden theme preview (src/themePreview) both
// import this one module, so a preview always paints with the production
// styles and a change here reaches both.
import "../styles.css";
// Bundled chat fonts. @font-face rules only download a face once text uses it.
import "@fontsource/pixelify-sans/400.css";
import "@fontsource/pixelify-sans/500.css";
import "@fontsource/pixelify-sans/600.css";
import "@fontsource/pixelify-sans/700.css";
import "@fontsource/vt323/400.css";
// The Lumen redesign must follow styles.css: same-named @keyframes and any
// equal-specificity rules resolve to whichever sheet comes last.
import "../styles/lumen/index.css";
