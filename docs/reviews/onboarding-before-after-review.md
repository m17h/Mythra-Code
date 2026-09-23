# Onboarding before/after review — 2026-09-23

Read-only product review of the committed nine-page onboarding at HEAD versus the current five-page working tree. Three GPT-6 Sol reviewers (high) independently reviewed coverage, behavior, and UI; Claude Opus 5.5 (high, local CLI through tmux) provided a separate design review. Root challenged the recommendations against code and fresh WebKit rendering. No application code changed in this review.

## Verdict

Keep the new design. It is a stronger first-run experience: five focused pages, provider-specific next steps, stricter provider readiness, clearer local/GitHub guidance, real theme/font/slider previews, and safer navigation. This is an engineering/design assessment, not measured user-study evidence.

The old tour's unsupported empty-harness-prompt, no-network, and blanket local-only claims should remain removed. So should its obsolete Cross-provider switch instructions. Detailed skills file formats, pinning, UI scale, and worker ceilings are better taught in the relevant app surfaces than restored as whole onboarding pages.

## Recommended refinements

1. **Correct control-scope wording.** `OnboardingModal.tsx:320` says permission/sub-agents are set per thread. `App.tsx:1366-1370` persists permission in shared settings; new-thread roster defaults persist globally or per project (`1377-1392`). Existing-thread roster edits have their own handling. Explain the actual scope without implying Full access is isolated to one thread.
2. **Carry provider intent through setup.** The provider radio selects an explanatory panel only. The Settings handoff passes `models`, not the selected provider (`OnboardingModal.tsx:225-226`, `App.tsx:6821-6825`). Settings seeds its provider from saved settings (`SettingsModal.tsx:620`), which can differ from the provider just selected. Carry the choice as an explicit setup draft and make the default-model choice clear. Avoid silently changing a user's established default merely because they inspected a provider tile.
3. **Carry the chosen look into an unsaved Settings draft.** Current preview-only copy is truthful and should remain. However, opening Settings clears the theme/font/slider preview (`OnboardingModal.tsx:651-655`), so users must recreate it. Transfer the combination to the draft, retain Save/Cancel semantics, and handle project-specific appearance defaults deliberately.
4. **Simplify Direct the work and improve detail-text legibility.** Fresh normal-size rendering has 177 words on this page, compared with 49–65 on the simpler pages. At 980×680 / 150%, its scrollable stage has 562 CSS px of content in 320 CSS px of viewport. Shorten repeated sub-agent wording, distinguish static permission explanations from selectable controls, and keep both synchronous/asynchronous question behavior in the concise explanation. Do not remove animations or cram the text smaller.
5. **Expose provider readiness accessibly.** Tile aria-labels currently contain only provider names, while kind/readiness dots are hidden from assistive technology. Associate readable status with each tile and use a stable live-status container for provider changes.

Small optional additions: a short browser-sign-in reassurance where verified, clearer links to Settings → Skills and Project instructions, and setup-first emphasis on Ready when no provider is usable. A one-line explanation of where model requests go would be more useful than restoring broad credential-storage promises; LM Studio can use a configured remote server and should not be described as unconditionally on-device.

## Suggestions deliberately not promoted

- Do not restore an “empty/no hidden prompt” claim: `mythraCodeDeveloperInstructions` supplies instructions independently of the user-editable prompt.
- Do not claim all credentials use an OS credential store without verifying each platform/provider path.
- Do not resize the whole modal on every step merely to remove spare space. Stable geometry can be preferable; improve spacing within sparse pages only if needed.
- A possible folder-picker/Start-chat race is not established as a user-facing defect because native modal pickers can block the underlying window. Do not prioritize it without native reproduction.

## Verification and limits

Fresh targeted checks: 14 unit/readiness tests, 10 Chromium onboarding tests, and 10 WebKit onboarding tests passed. Fresh WebKit screenshots covered all five pages at 1380×900 / 100% and 980×680 / 150%; footer reachability and scrolling remained intact. Screenshot fixtures use actual components with controlled readiness and are not a signed-in native walkthrough. No model prompts were submitted through Mythra Code. Native Windows onboarding remains a pre-release validation gap.

Artifacts are under `/tmp/mythra-1181/review-onboarding-*`; Opus's independent report is `/tmp/mythra-1181/opus-onboarding-fresh.json`. Existing source and previous uncommitted work were preserved.

## Implemented after approval

All five recommended refinements and the small optional links/sign-in guidance above are now implemented. Opus 5.5 handled the focused onboarding presentation and copy; three GPT-6 Sol reviewers handled Settings draft ownership, App integration regressions, and authentication/scope review. Root reviewed their changes and exercised the native macOS flow.

Provider selection and appearance previews transfer into unsaved Settings drafts. Save applies them; Cancel discards them and resumes the same tour page. A replay starts with the saved provider, and selecting that same provider preserves its saved model and Ultra setting. Appearance drafts preview over a project's look but save global defaults only; a conditional note explains when a project override will remain in effect. An available app update no longer redirects this explicit Interface handoff.

The Direct page is shorter, static permission explanations no longer resemble selectable cards, and detail text is larger. Shared permission scope, subscription/API/server usage, and provider-specific sign-in steps are stated accurately. Provider tiles expose readiness descriptions to assistive technology, with one stable live status. Project instructions and Skills are easier to find; Ready emphasizes setup when no provider is usable. Existing animation and preview behavior remain.

See the final verification and performance measurements in [1.18.1-validation.md](1.18.1-validation.md). Native Windows remains a pre-release validation gap.
