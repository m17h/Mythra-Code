# Desktop close safety and display failure

## Current boundary

The native close guard protects closing the main window when the WebView or its
JavaScript stops responding **while the native host remains responsive**. It
does not prevent an injected third-party DLL from crashing WebView2, recreate
the display, or recover a deadlocked native host.

The standard Tauri JavaScript close listener still prevents its default action
synchronously. It claims the current native request, flushes pending writes,
and reports the result. JavaScript must not destroy the window or own a second
discard dialog/deadline. Rust owns the final close decision:

- A healthy save completes the matching request and destroys the window.
- A failed save or unanswered request after 20 seconds opens a native dialog.
- A confirmed Windows browser/main-renderer exit allows native confirmation
  immediately when the user requests closing. Failure alone does not open a
  dialog, restart a task, or replay a prompt.
- Keep open, Cancel, and dismissal invalidate the request. Late save replies
  cannot override that choice. Request/window generations reject stale work.
- Healthy closing before the frontend listener is installed remains possible;
  a native watchdog belonging to a destroyed window becomes inert.

The dialog uses a non-destructive first/default button and an explicit result
allowlist. Do not swap two custom OK/Cancel labels or invert a boolean result:
the pinned dialog plugin maps underlying cancellation to the custom cancel
label. That can turn Escape or dismissal into an unintended discard.

Normal application-exit cleanup still owns runtime and child-process shutdown.
Updater integration is unchanged and is not verified by this repair. The pinned
macOS updater uses the nonzero restart path; the Windows updater exits directly
after framework cleanup, bypassing this guard and application RunEvent cleanup.

## Verification

Unit tests cover native request transitions and frontend callback races,
including Tauri's JavaScript helper's implicit destruction unless prevented.
These do not substitute for Windows native testing.

Use an isolated executable/profile, synthetic persistence, and no provider
credentials or real prompts for destructive fault tests. Verify healthy saves,
browser death after listener registration, frozen JavaScript/hung saves,
repeated close, Keep open then retry, Enter/Escape/dialog dismissal, explicit
discard, and cleanup of only fixture-owned processes. A fixture importing the
production module proves that module's native behavior, not the entire packaged
application, production provider cleanup, menu Quit, or updater integration.
Check that the independently identified host and backend processes have exited;
a cleanup audit label alone is not proof of successful termination.

## Follow-up architecture, not implemented by this repair

1. A durable backend session/event journal and reconciliation of provider
   history, drafts, pending approvals, queued/scheduled messages, and task IDs.
   Rebuilding the display must reconnect, not submit the work again.
2. Native startup milestones and independent failure surfaces are now covered
   by [desktop startup resilience](desktop-startup-resilience.md) for returned
   setup errors and responsive-host frontend failures. Blocked WebView
   construction and native-main-loop hangs remain unresolved boundaries.
3. Coordinated renderer reload versus browser/control recreation, with a fresh
   validated display generation and bounded retries. GPU/utility failures that
   WebView2 recovers automatically must not trigger destructive recovery.
4. Native packaged-candidate fault tests and runtime compatibility testing.
5. A separate supervisor/session service only if whole-host crash/deadlock
   recovery warrants its IPC, lifecycle, and security complexity.

Do not promise lossless recovery from close-flush completion alone. Native
settings mirrors currently settle writes with a local-storage fallback, and
provider event forwarding is not itself a durable session journal. Establish
and test each persistence boundary before making stronger guarantees.

Prefer documented native APIs over a framework fork. A narrow, pinned,
upstreamable Tauri/Wry patch is appropriate only for a demonstrated API or
lifecycle gap. Do not ship experimental browser switches, weaken browser
security, disable graphics globally, delete user profiles automatically, or
silently modify unrelated overlay/security software.
