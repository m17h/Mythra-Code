# Desktop startup resilience

## Ownership and healthy behavior

The normal application UI remains unchanged. Startup makes one attempt: load
saved data, validate it, import the application, and mount it. Slow hydration
continues using that same promise; it never races another attempt or mounts
partial defaults. An independent HTML/CSS/classic-script surface can explain
an entry, import, hydration, or render failure even when React cannot start.
After ten seconds it can show that startup is still in progress.

Renderer readiness is reported after the first React commit and effect flush.
A render/effect failure takes precedence over readiness. The notification uses
the public Tauri API and is deduplicated per document. Readiness establishes
JavaScript progress, not that healthy pixels were painted by the GPU.

The native host prepares the main-window generation before constructing the
window, retaining an early renderer acknowledgment. After construction, one
cancellable sixty-second deadline protects an unacknowledged startup. Ready or
visible-fallback acknowledgment cancels it. It is not a recurring healthy-session
watchdog. A stale deadline or dialog cannot act on a destroyed/replaced window
or a startup that subsequently recovered.

The native warning defaults to Keep waiting. Explicit Close goes through the
existing save/close guard, not immediate destruction. Returned updater, database,
and window-construction failures produce a native setup-failure explanation.
When setup failed before any main window exists, dismissing that fatal dialog
exits the empty host; there is no running user session to discard. An existing
main window still requires explicit Close through its guard. Failures before an
application handle exists log a fixed code and exit.

## Saved data

Known unsafe startup record shapes stop initialization before pending-write
replay or migrations. Guarded native reads distinguish an absent row from saved
JSON null and preserve malformed serialized values. Do not silently replace
invalid data with defaults, clear pending markers, delete a profile, or recommend
resetting it as the first recovery step. The user-facing message asks for a
restart and support before any data deletion/reset.

This validation is deliberately limited to shapes used unsafely during startup,
not a new strict schema for every historical field. A healthy authoritative
native record can repair a damaged non-pending webview cache. Invalid pending
writes remain available for diagnosis rather than being overwritten with older
native data.

## Containment and retries

Composer, conversation, workspace tools, and optional onboarding, search, and
workflow surfaces have local error boundaries. Optional failures are dismissible
without remounting the healthy shell/composer. Changing a surface identity resets
only a failed boundary; it does not erase a healthy draft. Manual retry of a failed
lazy conversation/tool load creates a fresh lazy component rather than resetting
only its cached rejected promise. Browser module caching can still require an
application restart after repeated import failures.

Error conversion/reporting is bounded and best-effort, including unusual thrown
values. A reporting failure must not crash its own fallback. Native startup
diagnostics and the independent startup surface contain fixed stages/codes, not
raw saved records, paths, provider output, or arbitrary exception messages.
The normal application's existing error log can still contain bounded error
text. Zero elapsed time in a setup-failure entry is an
unmeasured placeholder, not a timing measurement.

## Verification and limits

Use temporary identifiers, synthetic saved data, missing provider executables,
and verified credential/network isolation. Never burn subscription limits or
fault the installed user's application to test these paths. The existing native
close fixture includes a startup binary importing the production startup and
close guards; its behavior is fixture evidence, not full-application evidence.
Full-app checks must separately exercise healthy startup, saving/reopening,
invalid saved records with unchanged raw values, and native closing.

Production browser probes should block the actual emitted entry/application
chunks, check delayed hydration, and force render/effect failures. The performance
scorecard includes the dynamically imported startApplication module and public
bootstrap assets; their absence from a static manifest must not undercount startup
bytes. This work does not add CI lanes or loosen budgets.

Unresolved boundaries remain explicit:

- A blocked native WebView constructor or main event loop cannot run this timer.
- JavaScript readiness cannot detect a visually blank GPU surface.
- Third-party overlay injection is not prevented by an error boundary.
- No automatic reload, browser recreation, profile cleanup, graphics/security
  switches, prompt replay, or provider-task restart is introduced.
- Lossless running-task recovery still requires a durable backend session/event
  journal. Saved-data validation and close flushing do not establish that journal.

See [desktop-close-recovery.md](desktop-close-recovery.md) for close ownership
and the remaining recovery architecture.
