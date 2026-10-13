# Native performance harness retired

Automated native performance captures and tests are disabled until Morgan
explicitly reintroduces them. Do not launch repeated desktop captures, idle
soaks, A/B comparisons or harness validation for a change, merge or release.

Older reports may contain main-process CPU/resident-memory and window-visibility
measurements. Those observations describe their recorded executable, machine and
probe settings. Window visibility is not first paint or interactivity, and main
process memory excludes WebView helpers. Keep those limits when discussing
historical results.

Preserve active applications, real profiles and retained measurements. Disabling
the harness does not authorize deleting them or changing user data.
See [performance notes](../PERFORMANCE.md) for the current policy.
