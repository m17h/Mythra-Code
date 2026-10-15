//! On-demand local spelling suggestions. No document contents, provider calls,
//! dictionary downloads, or changes to the user's learned spelling dictionary.
use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct SpellingSuggestions {
    misspelled: bool,
    suggestions: Vec<String>,
}

// Own the permit until the actual OS call returns, not just until its caller
// stops waiting. Rapid clicks cannot accumulate blocking dictionary jobs.
static SPELLING_SLOT: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)));

#[tauri::command]
pub(crate) async fn spelling_suggestions(
    app: tauri::AppHandle,
    word: String,
    language: Option<String>,
) -> Result<SpellingSuggestions, String> {
    if word.is_empty()
        || word.len() > 512
        || word.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("Invalid spelling word".into());
    }
    let language = language.filter(|value| !value.is_empty());
    if language.as_ref().is_some_and(|value| {
        value.len() > 64 || !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    }) {
        return Err("Invalid spelling language".into());
    }
    let permit = SPELLING_SLOT
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Spelling lookup already in progress".to_string())?;

    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _permit = permit;
            let _ = send.send(mac_suggestions(&word, language.as_deref()));
        })
        .map_err(|_| "Spelling service unavailable".to_string())?;
        return receive
            .await
            .map_err(|_| "Spelling service unavailable".to_string())?;
    }
    #[cfg(windows)]
    {
        let _ = app;
        return tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            windows_suggestions(&word, language.as_deref())
        })
        .await
        .map_err(|_| "Spelling service unavailable".to_string())?;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, word, language, permit);
        Err("Spelling suggestions are not available on this platform".into())
    }
}

/// WKWebView leaves "Check Spelling While Typing" off unless the host app
/// opts in, so macOS editors never showed the red underline WebView2 draws by
/// default. These are registration defaults: nothing is written to the user's
/// preferences. Automatic correction stays off so enabling the underline does
/// not start rewriting identifiers while typing; grammar stays off as well.
#[cfg(target_os = "macos")]
pub(crate) fn register_webkit_spelling_defaults() {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{ns_string, NSDictionary, NSNumber, NSUserDefaults};

    objc2::rc::autoreleasepool(|_| {
        let on = NSNumber::numberWithBool(true);
        let off = NSNumber::numberWithBool(false);
        let defaults = NSDictionary::<_, AnyObject>::from_slices(
            &[
                ns_string!("WebContinuousSpellCheckingEnabled"),
                ns_string!("WebAutomaticSpellingCorrectionEnabled"),
                ns_string!("WebGrammarCheckingEnabled"),
            ],
            &[&**on, &**off, &**off],
        );
        // The dictionary holds NSString keys and NSNumber values, as required.
        unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&defaults) };
    });
}

#[cfg(target_os = "macos")]
fn mac_suggestions(word: &str, requested: Option<&str>) -> Result<SpellingSuggestions, String> {
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{NSRange, NSString};

    objc2::rc::autoreleasepool(|_| {
        let checker = NSSpellChecker::sharedSpellChecker();
        let text = NSString::from_str(word);
        let language = requested
            .map(NSString::from_str)
            .unwrap_or_else(|| checker.language());
        if !checker.availableLanguages().iter().any(|item| {
            item.to_string()
                .replace('_', "-")
                .eq_ignore_ascii_case(&language.to_string().replace('_', "-"))
        }) {
            return Err("No dictionary for this language".into());
        }
        let tag = NSSpellChecker::uniqueSpellDocumentTag();
        // Every call is on AppKit's main thread. The optional word count is null.
        let range = unsafe {
            checker.checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount(
                &text,
                0,
                Some(&language),
                false,
                tag,
                std::ptr::null_mut(),
            )
        };
        let misspelled = range.length > 0;
        let suggestions = if misspelled {
            checker
                .guessesForWordRange_inString_language_inSpellDocumentWithTag(
                    NSRange::new(0, word.encode_utf16().count()),
                    &text,
                    Some(&language),
                    tag,
                )
                .map(|items| items.iter().take(6).map(|item| item.to_string()).collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        checker.closeSpellDocumentWithTag(tag);
        Ok(SpellingSuggestions {
            misspelled,
            suggestions,
        })
    })
}

#[cfg(windows)]
fn windows_suggestions(word: &str, requested: Option<&str>) -> Result<SpellingSuggestions, String> {
    use windows::{
        core::{HSTRING, PWSTR},
        Win32::{
            Globalization::{GetUserDefaultLocaleName, ISpellCheckerFactory, SpellCheckerFactory},
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
            },
        },
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let unavailable = |_| "Spelling service unavailable".to_string();
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(unavailable)?;
        let _apartment = Apartment;
        let factory: ISpellCheckerFactory =
            CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(unavailable)?;
        let mut locale = [0u16; 85];
        let length = GetUserDefaultLocaleName(&mut locale);
        let language = requested
            .map(str::to_owned)
            .or_else(|| {
                (length > 1).then(|| String::from_utf16_lossy(&locale[..length as usize - 1]))
            })
            .ok_or_else(|| "No spelling language available".to_string())?;
        let checker = factory
            .CreateSpellChecker(&HSTRING::from(language))
            .map_err(unavailable)?;
        let text = HSTRING::from(word);
        let errors = checker.Check(&text).map_err(unavailable)?;
        let mut first = None;
        errors.Next(&mut first).ok().map_err(unavailable)?;
        let misspelled = first.is_some();
        let mut suggestions = Vec::new();
        if misspelled {
            let items = checker.Suggest(&text).map_err(unavailable)?;
            for _ in 0..6 {
                let mut pointer = [PWSTR::null()];
                let mut fetched = 0;
                let result = items.Next(&mut pointer, Some(&mut fetched));
                // COM allocates every returned string; free it on all paths.
                let value = if !pointer[0].is_null() {
                    pointer[0].to_string().ok()
                } else {
                    None
                };
                if !pointer[0].is_null() {
                    CoTaskMemFree(Some(pointer[0].0.cast()));
                }
                result.ok().map_err(unavailable)?;
                if fetched == 0 {
                    break;
                }
                if let Some(value) = value {
                    suggestions.push(value);
                }
            }
        }
        Ok(SpellingSuggestions {
            misspelled,
            suggestions,
        })
    }
}
