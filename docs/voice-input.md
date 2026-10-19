# Voice input

The microphone button in the composer records speech and turns it into text in the draft. It works the same in every chat provider's threads. Stopping a recording uploads it to the selected transcription provider; the text that comes back is appended to the end of the draft, after any text already there, and attachments stay as they are. The chat message itself is never sent automatically.

## Setup

Settings › **Voice input** chooses one active transcription provider, OpenAI or OpenRouter, and a model for each. Provider and model are ordinary settings saved with **Save settings**. They have nothing to do with the chat provider, model, account or subscription. A ChatGPT, Claude or Cursor plan does not cover transcription; the provider bills it to the API key added here.

Each provider has its own transcription key in the OS credential store (`com.kiwi.harness` / `transcription-openai-api-key` and `transcription-openrouter-api-key`). A pasted key is passed to native code once to be saved. Keys are saved or removed immediately, never enter app settings or local storage, are never logged, are never returned by any command, and saving one does not restart a runtime. Writes for one provider are serialized; a write that finishes after its 10-second wait is still applied in order. A locked, denied or failing credential store is reported as unreadable, not as a missing key. Both keys stay saved when the active provider changes, but a recording goes only to the active provider. Nothing falls back to the other provider. **Use key from Models & accounts** copies the existing OpenRouter chat key into the separate transcription entry natively; the chat key itself is only read.

Model lists load only while the Voice input pane is open, or on Refresh:

- **OpenAI**: the documented models for the upload endpoint (`gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and their dated snapshots, `whisper-1`) intersected with `/v1/models` for the transcription key. Without a key, or when the list can't be read, the documented list is shown and labelled as such. Realtime-only and diarization models are not offered.
- **OpenRouter**: the public `output_modalities=transcription` catalog, checked again on the native side (audio input, transcription output, deduplicated). An upload is only made with a model from that catalog.

Catalogs are cached for 30 minutes per provider, and requests share one fetch. The OpenAI list is tied to the key it was fetched with: saving, replacing or removing the key invalidates it, and the open Settings page reloads it.

## Recording to draft

1. Pressing the microphone checks the key first, then the model, and obtains a native request ID before recording. With no key, the **No transcription API key** dialog offers **Open transcription settings**; with no model, a similar dialog asks for one. These setup dialogs remain usable. The microphone is not opened until these checks pass. (The audio context is created inside the click, because some engines require a user gesture for audio; that does not open the microphone.) Setup, including an OS permission prompt, is abandoned after 60 seconds.
2. Recording captures mono 16-bit PCM WAV at 16 kHz, or the device rate if lower (an AudioWorklet served from the app, with a fallback for engines without one). It stops and transcribes automatically at 10 minutes, about 19 MB of WAV data, below the providers' 25 MB limit. Total working memory can be higher than the final WAV size. A wall-clock timer enforces the limit even if the audio graph stops delivering samples. Stopping the older fallback collects one final audio callback, normally waiting up to 400 ms. Lower sample rates get time for one audio buffer plus scheduling room, capped at one second; Discard still releases capture immediately.
3. **Stop & transcribe** uploads that one file to the fixed HTTPS endpoint of the active provider. Redirects are refused, responses are size-limited, and Mythra Code never automatically retries an uncertain request. Very short or silent recordings are not uploaded.
4. An app-themed voice dialog keeps the destination fixed during setup, recording, finishing and transcription. New thread, conversation/project navigation, Settings, draft actions and their keyboard shortcuts are blocked until voice input finishes or is canceled. Stop & transcribe and Discard/Cancel remain available, as does closing the window. The transcript is appended to the preserved draft; the message is not sent automatically. Afterward the rest of the app becomes usable again.

Voice input is canceled, the microphone released and any upload aborted natively when you press Discard/Cancel, close the composer, or request to close the window (including Quit). The same cancellation guards remain in place if the app replaces the draft or its thread, provider or model changes through another asynchronous path; a late transcript cannot be appended to a different draft.

The app's backup communication transport is supported too. A repeated invocation for the same native-issued request ID joins the existing upload or retrieves its recent result instead of uploading again. Changing the audio, provider or model while reusing that ID is refused. Even after a cached result expires, a consumed ID cannot start another upload in the same app process.

Hiding the window discards setup, a recording in progress, or a recording still being finalized locally, and releases the microphone. Hiding never starts a paid upload. On macOS, a window fully covered by another full-screen app can also count as hidden. A disconnected microphone discards a recording that hasn't been uploaded yet. An upload already in progress continues while the window is hidden, because its text still goes to the open draft. Escape cancels setup, recording, or the final local audio flush; once the audio has been submitted for transcription, use the explicit Cancel button instead. Requesting to close the window cancels voice input immediately, even while pending changes are being saved or a close confirmation is open. A provider may still bill an upload it had received before it was canceled.

Provider errors use fixed messages chosen from the HTTP status. Provider error text, audio and raw response bodies are never shown or logged; only the recognized transcript is added to the draft.

## Platform notes

- **macOS** asks for microphone permission the first time (the app declares `NSMicrophoneUsageDescription` and the hardened-runtime `audio-input` entitlement). If access was denied, turn it on in System Settings › Privacy & Security › Microphone.
- **Windows** shows the WebView's microphone prompt, and the system setting Settings › Privacy & security › Microphone must allow desktop apps.

Mythra Code keeps audio only in memory until the request ends and never writes it to disk. To recover a lost internal response without another paid upload, native code retains recent transcript/error results in memory for at most 10 minutes, bounded to 16 results and 2 MiB total; canceling discards the request's cached transcript. No audio is retained in this cache. The provider processes, and may retain, the uploaded audio under its own policies.

## Known limitations

- A key saved or removed outside Mythra Code (for example in Keychain Access) after the app has written that key itself is not noticed until restart.
- **Use key from Models & accounts** cannot distinguish an unreadable credential store from a missing chat key; both report that no key could be read and suggest saving one or retrying after unlocking the credential store.
- A key write that times out reports failure even if the OS completes it later; reopening Voice input settings (or pressing the microphone) re-reads the status and shows the result.
