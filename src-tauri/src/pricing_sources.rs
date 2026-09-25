//! Fetches the providers' official pricing pages for the usage page's rate
//! refresh. The OpenAI, Claude and Cursor Markdown pages are not served with
//! CORS headers, so the webview cannot read them directly.
//!
//! The command reads only three fixed HTTPS documents and never a caller URL.
//! It sends no credentials or cookies and returns bounded UTF-8 text. Parsing
//! and validation stay in the renderer, which fails closed on any layout it
//! does not recognise.

use std::time::Duration;

use reqwest::{header::CONTENT_TYPE, redirect, Url};

/// The published pages are tens of kilobytes. Anything this large is not the
/// pricing page, so reading stops before it can grow further.
const MAX_PRICING_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

fn pricing_document_url(source: &str) -> Option<&'static str> {
    match source {
        "openai" => Some("https://developers.openai.com/api/docs/pricing.md"),
        "anthropic" => Some("https://platform.claude.com/docs/en/about-claude/pricing.md"),
        "cursor" => Some("https://cursor.com/docs/models-and-pricing.md"),
        _ => None,
    }
}

/// A redirect may move within the same HTTPS host (a trailing slash, a
/// renamed path) but never to another site.
fn redirect_allowed(origin: &Url, next: &Url, hops: usize) -> bool {
    hops < MAX_REDIRECTS
        && next.scheme() == "https"
        && next.host_str().is_some()
        && next.host_str() == origin.host_str()
        && next.port_or_known_default() == Some(443)
}

/// Markdown is served as `text/markdown` or `text/plain`. An HTML page means
/// the Markdown endpoint moved, which should read as a failure rather than be
/// handed to the parser.
fn accepts_content_type(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    let mime = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    mime.starts_with("text/") && mime != "text/html"
}

fn append_bounded(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) > MAX_PRICING_DOCUMENT_BYTES {
        return Err("The pricing page was unexpectedly large".into());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

#[tauri::command]
pub async fn fetch_pricing_document(source: String) -> Result<String, String> {
    let url = pricing_document_url(&source).ok_or("Unknown pricing source")?;
    let origin = Url::parse(url).map_err(|_| "Invalid pricing source")?;
    let policy_origin = origin.clone();
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(redirect::Policy::custom(move |attempt| {
            let hops = attempt.previous().len();
            if redirect_allowed(&policy_origin, attempt.url(), hops) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .user_agent(concat!("MythraCode/", env!("CARGO_PKG_VERSION"), " pricing-check"))
        .build()
        .map_err(|error| format!("Could not create the pricing client: {error}"))?;
    // No `Accept` header: cursor.com answers `Accept: text/markdown` with 404.
    let mut response = client
        .get(origin.clone())
        .send()
        .await
        .map_err(|error| format!("Could not reach the pricing page: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The pricing page returned HTTP {}",
            response.status().as_u16()
        ));
    }
    if response.url().host_str() != origin.host_str() {
        return Err("The pricing page redirected to another site".into());
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    if !accepts_content_type(content_type) {
        return Err("The pricing page was not returned as text".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PRICING_DOCUMENT_BYTES as u64)
    {
        return Err("The pricing page was unexpectedly large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read the pricing page: {error}"))?
    {
        append_bounded(&mut body, &chunk)?;
    }
    String::from_utf8(body).map_err(|_| "The pricing page was not UTF-8 text".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_fixed_https_pages_can_be_requested() {
        for source in ["openai", "anthropic", "cursor"] {
            let url = Url::parse(pricing_document_url(source).unwrap()).unwrap();
            assert_eq!(url.scheme(), "https", "{source}");
            assert!(url.path().ends_with(".md"), "{source}");
            assert!(url.query().is_none(), "{source}");
            assert!(url.username().is_empty() && url.password().is_none(), "{source}");
        }
        for source in [
            "",
            "OpenAI",
            "openrouter",
            "https://developers.openai.com/api/docs/pricing.md",
            "../openai",
        ] {
            assert!(pricing_document_url(source).is_none(), "{source}");
        }
    }

    #[test]
    fn redirects_stay_on_the_same_https_host_and_are_bounded() {
        let origin = Url::parse("https://cursor.com/docs/models-and-pricing.md").unwrap();
        let same = Url::parse("https://cursor.com/docs/models-and-pricing/").unwrap();
        assert!(redirect_allowed(&origin, &same, 0));
        assert!(!redirect_allowed(&origin, &same, MAX_REDIRECTS));
        for next in [
            "http://cursor.com/docs/models-and-pricing.md",
            "https://evil.example/cursor.com",
            "https://cursor.com.evil.example/docs",
            "https://cursor.com:8443/docs",
        ] {
            assert!(!redirect_allowed(&origin, &Url::parse(next).unwrap(), 0), "{next}");
        }
    }

    #[test]
    fn accepts_markdown_and_plain_text_but_not_html_or_binary() {
        assert!(accepts_content_type(Some("text/markdown; charset=utf-8")));
        assert!(accepts_content_type(Some("text/plain")));
        assert!(accepts_content_type(Some("Text/X-Markdown")));
        assert!(!accepts_content_type(Some("text/html; charset=utf-8")));
        assert!(!accepts_content_type(Some("application/octet-stream")));
        assert!(!accepts_content_type(Some("application/json")));
        assert!(!accepts_content_type(None));
    }

    #[test]
    fn stops_reading_past_the_size_cap() {
        let mut body = Vec::new();
        append_bounded(&mut body, &vec![b'a'; MAX_PRICING_DOCUMENT_BYTES - 1]).unwrap();
        append_bounded(&mut body, b"b").unwrap();
        assert!(append_bounded(&mut body, b"c").is_err());
        assert_eq!(body.len(), MAX_PRICING_DOCUMENT_BYTES);
    }

    /// Live check for native QA. Fetches each page through the real command
    /// and saves it for the renderer's captured-page parser test:
    /// `npm run test:rust -- capture_pricing_pages -- --ignored`
    /// then `npx vitest run src/lib/officialPricing.captured.test.ts`.
    #[tokio::test]
    #[ignore = "network"]
    async fn capture_pricing_pages() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../node_modules/.cache/pricing");
        std::fs::create_dir_all(dir).unwrap();
        for (source, anchor) in [
            ("openai", "### Standard pricing data"),
            (
                "anthropic",
                "The following table shows pricing for all Claude models:",
            ),
            ("cursor", "### Model pricing"),
        ] {
            let text = fetch_pricing_document(source.into())
                .await
                .unwrap_or_else(|error| panic!("{source}: {error}"));
            assert!(text.contains(anchor), "{source} no longer contains {anchor:?}");
            std::fs::write(format!("{dir}/{source}.md"), text).unwrap();
        }
    }
}
