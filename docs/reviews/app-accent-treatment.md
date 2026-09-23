# App-wide accent treatment

Morgan requested the calmer onboarding treatment throughout Mythra Code: less
blue surface area while keeping the app's theme identity, premium motion, and
clear controls.

## Design rules

- Use neutral raised surfaces for static cards, informational panels, header
  icon tiles, and selected-row fills.
- Use outlined primary actions with accent ink and edges, never solid accent fills.
- Keep accent on focus indicators, active toggle thumbs,
  selected edges/icons, progress, and concise status cues.
- Keep warnings, errors, Git diff meaning, provider identity, theme previews,
  usage charts, and animated effort-slider palettes distinct.
- Preserve animation and saved preferences. Compact collapsed sub-agent tiles;
  signed-out OpenAI/Claude choices stay visible and muted, and activation shows
  a timed sign-in toast without changing the selection. Removal stays available.

Opus 5.5 implements the CSS pass; the root reviewer audits the resulting diff
and checks native behavior. Screenshots must be from the development app, with
any temporary theme previews cancelled afterward. No model prompts are needed
to test these visual changes.

Validation results and delivery evidence are recorded in
[1.18.1-validation.md](1.18.1-validation.md).
