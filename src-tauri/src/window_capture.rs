//! A picture of the hidden theme preview (theme_preview.rs) for the theme
//! tool `capture_app_screenshot`.
//!
//! The picture comes from that preview's own webview, never from the screen
//! and never from the window the person uses: WKWebView
//! `takeSnapshotWithConfiguration:` on macOS and WebView2 `CapturePreview` on
//! Windows. Neither is screen recording, so no system permission (Screen
//! Recording, ScreenCaptureKit) is ever involved, and other apps' windows can
//! never appear in it. Other platforms report that pictures are not available.
//!
//! The preview window is never shown. A webview that did not paint returns a
//! blank picture, which is reported as a failure instead of being sent. On
//! Windows a failed or blank `CapturePreview` is retried once through the
//! same controller's in-process DevTools protocol (`Page.captureScreenshot`
//! via `CallDevToolsProtocolMethod`: no debugging port, nothing shown).

#[cfg(any(target_os = "macos", windows))]
use std::sync::Mutex;

#[cfg(any(target_os = "macos", windows))]
use tokio::sync::oneshot;

/// Widest picture sent to a model, in pixels.
pub(crate) const MAX_WIDTH: u32 = 1280;
/// Largest PNG sent to a model; wider steps down until it fits.
pub(crate) const MAX_PNG_BYTES: usize = 1_200_000;
/// Largest native PNG accepted before shrinking (a 6K window is ~40 MB raw).
const MAX_NATIVE_PNG_BYTES: usize = 64 * 1024 * 1024;
const MAX_NATIVE_PIXELS: u64 = 8192 * 8192;

/// Photograph a hidden preview webview: a downscaled PNG and its size.
/// Callers pass only the preview session's own webview (theme_preview.rs)
/// and bound the whole call with the session's deadline.
pub(crate) async fn capture_preview_png(webview: &tauri::Webview, viewport: (u32, u32)) -> Result<(Vec<u8>, u32, u32), String> {
    if !crate::theme_preview::is_preview_label(webview.label()) {
        return Err("Only the hidden theme preview can be photographed.".into());
    }
    let first = match native_capture(webview).await {
        Ok(native) => painted(native, viewport).await,
        Err(error) => Err(error),
    };
    let image = match first {
        Ok(image) => image,
        Err(first) => match fallback_capture(webview).await {
            None => return Err(first),
            Some(Ok(native)) => painted(native, viewport).await.map_err(|second| format!("{first}; then {second}"))?,
            Some(Err(second)) => return Err(format!("{first}; then {second}")),
        },
    };
    tauri::async_runtime::spawn_blocking(move || shrink_image(&image, MAX_WIDTH, MAX_PNG_BYTES))
        .await
        .map_err(|_| "The picture could not be prepared.".to_string())?
}

/// The decoded picture, unless the webview never painted.
async fn painted(native: Vec<u8>, viewport: (u32, u32)) -> Result<Rgba, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let image = decode_png(&native)?;
        let (width, height) = viewport;
        // Both snapshots cover the viewport. Allow pixel rounding and backing
        // scale differences while discarding tiny or dimensionally wrong frames.
        let expected = f64::from(width) / f64::from(height);
        let actual = f64::from(image.width) / f64::from(image.height);
        if image.width < 32 || image.height < 32 || (actual / expected - 1.0).abs() > 0.02 {
            return Err("The picture did not match the theme preview's viewport.".to_string());
        }
        if looks_blank(&image) {
            return Err("the hidden preview did not paint on this system".to_string());
        }
        Ok(image)
    })
    .await
    .map_err(|_| "The picture could not be prepared.".to_string())?
}

/// One colour (or fully transparent) everywhere: the webview never painted.
/// The preview always draws text and borders, so a real frame is never uniform.
pub(crate) fn looks_blank(image: &Rgba) -> bool {
    let pixels = image.pixels.chunks_exact(4);
    let count = pixels.len();
    if count == 0 {
        return true;
    }
    let step = (count / 20_000).max(1);
    let mut low = [u8::MAX; 3];
    let mut high = [0u8; 3];
    for pixel in image.pixels.chunks_exact(4).step_by(step) {
        if pixel[3] == 0 {
            continue;
        }
        for channel in 0..3 {
            low[channel] = low[channel].min(pixel[channel]);
            high[channel] = high[channel].max(pixel[channel]);
            if high[channel].saturating_sub(low[channel]) > 2 {
                return false;
            }
        }
    }
    true
}

// ---- Shrinking (pure, every platform) -------------------------------------------

/// RGBA8 pixels.
pub(crate) struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

pub(crate) fn decode_png(bytes: &[u8]) -> Result<Rgba, String> {
    if bytes.len() > MAX_NATIVE_PNG_BYTES {
        return Err("The window picture is too large.".into());
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| "The window picture could not be read.".to_string())?;
    let info = reader.info();
    if (info.width as u64) * (info.height as u64) > MAX_NATIVE_PIXELS || info.width == 0 || info.height == 0 {
        return Err("The window picture has an unexpected size.".into());
    }
    let mut buffer = vec![0; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut buffer).map_err(|_| "The window picture could not be read.".to_string())?;
    buffer.truncate(frame.buffer_size());
    let (width, height) = (frame.width, frame.height);
    let count = (width as usize) * (height as usize);
    let pixels = match frame.color_type {
        png::ColorType::Rgba => buffer,
        png::ColorType::Rgb => buffer.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => buffer.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => buffer.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("The window picture has an unexpected format.".into()),
    };
    if pixels.len() != count * 4 {
        return Err("The window picture could not be read.".into());
    }
    Ok(Rgba { width, height, pixels })
}

pub(crate) fn encode_png(image: &Rgba) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Default);
        let mut writer = encoder.write_header().map_err(|_| "The picture could not be encoded.".to_string())?;
        writer.write_image_data(&image.pixels).map_err(|_| "The picture could not be encoded.".to_string())?;
    }
    Ok(out)
}

/// Box-filter downscale to `width` (aspect kept). Each output pixel averages
/// the source area it covers, with fractional edge weights.
pub(crate) fn downscale(image: &Rgba, width: u32) -> Rgba {
    if width >= image.width || width == 0 {
        return Rgba { width: image.width, height: image.height, pixels: image.pixels.clone() };
    }
    let scale = image.width as f64 / width as f64;
    let height = ((image.height as f64 / scale).round() as u32).max(1);
    let y_scale = image.height as f64 / height as f64;
    let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
    let src_w = image.width as usize;
    for oy in 0..height as usize {
        let y0 = oy as f64 * y_scale;
        let y1 = (y0 + y_scale).min(image.height as f64);
        for ox in 0..width as usize {
            let x0 = ox as f64 * scale;
            let x1 = (x0 + scale).min(image.width as f64);
            let mut sum = [0f64; 4];
            let mut total = 0f64;
            let mut y = y0.floor() as usize;
            while (y as f64) < y1 {
                let wy = ((y + 1) as f64).min(y1) - (y as f64).max(y0);
                let mut x = x0.floor() as usize;
                while (x as f64) < x1 {
                    let wx = ((x + 1) as f64).min(x1) - (x as f64).max(x0);
                    let weight = wx * wy;
                    let i = (y * src_w + x) * 4;
                    let alpha = image.pixels[i + 3] as f64;
                    // Premultiplied average, so transparent pixels don't darken edges.
                    sum[0] += image.pixels[i] as f64 * alpha * weight;
                    sum[1] += image.pixels[i + 1] as f64 * alpha * weight;
                    sum[2] += image.pixels[i + 2] as f64 * alpha * weight;
                    sum[3] += alpha * weight;
                    total += weight;
                    x += 1;
                }
                y += 1;
            }
            let o = (oy * width as usize + ox) * 4;
            if sum[3] > 0.0 {
                for c in 0..3 {
                    pixels[o + c] = (sum[c] / sum[3]).round().clamp(0.0, 255.0) as u8;
                }
            }
            pixels[o + 3] = if total > 0.0 { (sum[3] / total).round().clamp(0.0, 255.0) as u8 } else { 0 };
        }
    }
    Rgba { width, height, pixels }
}

/// Native PNG → a PNG at most `max_width` wide and `max_bytes` long (steps
/// down in width until it fits). Returns (png, width, height).
#[cfg(test)]
pub(crate) fn shrink_png(native: &[u8], max_width: u32, max_bytes: usize) -> Result<(Vec<u8>, u32, u32), String> {
    shrink_image(&decode_png(native)?, max_width, max_bytes)
}

/// A decoded picture → a PNG at most `max_width` wide and `max_bytes` long
/// (steps down in width until it fits). Returns (png, width, height).
pub(crate) fn shrink_image(image: &Rgba, max_width: u32, max_bytes: usize) -> Result<(Vec<u8>, u32, u32), String> {
    let mut width = image.width.min(max_width);
    loop {
        let small = downscale(image, width);
        let png = encode_png(&small)?;
        if png.len() <= max_bytes {
            return Ok((png, small.width, small.height));
        }
        if width <= 480 {
            return Err("The window picture is too detailed to send.".into());
        }
        width = (width as f64 * 0.8) as u32;
    }
}

// ---- Native capture ---------------------------------------------------------------

/// One native snapshot attempt. Windows may make two (preview, then DevTools),
/// so its attempts are shorter; the session deadline bounds them all.
#[cfg(target_os = "macos")]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
#[cfg(windows)]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

#[cfg(any(target_os = "macos", windows))]
fn capture_pending<T>(reply: &Mutex<Option<oneshot::Sender<Result<T, String>>>>) -> bool {
    reply.lock().is_ok_and(|slot| slot.as_ref().is_some_and(|tx| !tx.is_closed()))
}

#[cfg(any(target_os = "macos", windows))]
async fn await_capture<T>(receiver: oneshot::Receiver<Result<T, String>>) -> Result<T, String> {
    match tokio::time::timeout(CAPTURE_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The window did not return a picture.".into()),
        Err(_) => Err("The window did not return a picture in time.".into()),
    }
}

#[cfg(target_os = "macos")]
async fn native_capture(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWindow};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    let (sender, receiver) = oneshot::channel::<Result<Vec<u8>, String>>();
    let reply = std::sync::Arc::new(Mutex::new(Some(sender)));
    let scheduled = webview.with_webview(move |platform| {
        if !capture_pending(&reply) {
            return;
        }
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(Err("The window could not be captured from here.".into()));
            }
            return;
        };
        let finish = reply.clone();
        let handler = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
            let Some(tx) = finish.lock().ok().and_then(|mut slot| slot.take()) else {
                return;
            };
            if tx.is_closed() {
                return;
            }
            // SAFETY: WebKit passes a valid NSImage (or nil) for the duration
            // of the callback, on the main thread.
            let png = unsafe { Retained::retain(image) }
                .and_then(|image| image.TIFFRepresentation())
                .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                .and_then(|rep| unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) });
            let result = match png {
                Some(data) if data.length() <= MAX_NATIVE_PNG_BYTES => Ok(data.to_vec()),
                Some(_) => Err("The window picture is too large.".into()),
                None => Err("The window did not return a picture.".into()),
            };
            let _ = tx.send(result);
        });
        // SAFETY: Tauri supplies the live WKWebView on its owning (main) thread.
        unsafe {
            let view = &*platform.inner().cast::<WKWebView>();
            let config = WKSnapshotConfiguration::new(mtm);
            // WebKit takes points. Scale large views before the completion
            // handler converts the image, using only main-thread native reads.
            let window = platform.ns_window().cast::<NSWindow>().as_ref();
            let scale = window.map_or(1.0, NSWindow::backingScaleFactor);
            if scale.is_finite() && scale > 0.0 {
                let width = f64::from(MAX_WIDTH) / scale;
                if width < view.bounds().size.width {
                    config.setSnapshotWidth(Some(&NSNumber::numberWithDouble(width)));
                }
            }
            view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
        }
    });
    if scheduled.is_err() {
        return Err("The window could not be captured.".into());
    }
    await_capture(receiver).await
}

#[cfg(windows)]
async fn native_capture(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    use webview2_com::{CapturePreviewCompletedHandler, Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG};
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::{IStream, StructuredStorage::CreateStreamOnHGlobal, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};

    fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
        // SAFETY: plain COM calls on a stream this function's caller owns.
        unsafe {
            let mut stat = STATSTG::default();
            stream.Stat(&mut stat, STATFLAG_NONAME).map_err(|_| "The window picture could not be read.".to_string())?;
            let size = usize::try_from(stat.cbSize).map_err(|_| "The window picture is too large.".to_string())?;
            if size == 0 || size > MAX_NATIVE_PNG_BYTES {
                return Err("The window picture has an unexpected size.".into());
            }
            stream.Seek(0, STREAM_SEEK_SET, None).map_err(|_| "The window picture could not be read.".to_string())?;
            let mut bytes = vec![0u8; size];
            let mut read = 0u32;
            stream
                .Read(bytes.as_mut_ptr().cast(), size as u32, Some(&mut read as *mut u32))
                .ok()
                .map_err(|_| "The window picture could not be read.".to_string())?;
            if read as usize != size {
                return Err("The window picture was incomplete.".into());
            }
            Ok(bytes)
        }
    }

    let (sender, receiver) = oneshot::channel::<Result<Vec<u8>, String>>();
    let reply = std::sync::Arc::new(Mutex::new(Some(sender)));
    let scheduled = webview.with_webview(move |platform| {
        if !capture_pending(&reply) {
            return;
        }
        let fail = |message: &str| {
            if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(Err(message.to_string()));
            }
        };
        // SAFETY: Tauri supplies the live WebView2 controller on its owning thread.
        let started = unsafe {
            (|| -> windows::core::Result<()> {
                let core = platform.controller().CoreWebView2()?;
                let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
                let target = stream.clone();
                let finish = reply.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |result: windows::core::Result<()>| {
                    let Some(tx) = finish.lock().ok().and_then(|mut slot| slot.take()) else {
                        return Ok(());
                    };
                    if tx.is_closed() {
                        return Ok(());
                    }
                    let outcome = result
                        .map_err(|_| "The window did not return a picture.".to_string())
                        .and_then(|()| read_stream(&target));
                    let _ = tx.send(outcome);
                    Ok(())
                }));
                core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
            })()
        };
        if started.is_err() {
            fail("The window could not be captured.");
        }
    });
    if scheduled.is_err() {
        return Err("The window could not be captured.".into());
    }
    await_capture(receiver).await
}

/// The second attempt after a failed or blank first one, where there is one.
#[cfg(not(windows))]
async fn fallback_capture(_webview: &tauri::Webview) -> Option<Result<Vec<u8>, String>> {
    None
}

/// `Page.captureScreenshot` on this exact webview's own controller, through
/// WebView2's in-process DevTools protocol channel (no remote debugging port
/// is opened, and the window stays hidden). Whether it paints a never-shown
/// controller is not verified.
#[cfg(windows)]
async fn fallback_capture(webview: &tauri::Webview) -> Option<Result<Vec<u8>, String>> {
    use base64::Engine;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    fn decode(json: String) -> Result<Vec<u8>, String> {
        #[derive(serde::Deserialize)]
        struct Picture<'a> {
            #[serde(borrow)]
            data: std::borrow::Cow<'a, str>,
        }
        let unreadable = || "The DevTools picture could not be read.".to_string();
        if json.len() > MAX_NATIVE_PNG_BYTES / 3 * 4 + 64 {
            return Err("The DevTools picture is too large.".into());
        }
        let picture: Picture<'_> = serde_json::from_str(&json).map_err(|_| unreadable())?;
        base64::engine::general_purpose::STANDARD.decode(picture.data.as_bytes()).map_err(|_| unreadable())
    }

    let (sender, receiver) = oneshot::channel::<Result<String, String>>();
    let reply = std::sync::Arc::new(Mutex::new(Some(sender)));
    let scheduled = webview.with_webview(move |platform| {
        if !capture_pending(&reply) {
            return;
        }
        let fail = |message: &str| {
            if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(Err(message.to_string()));
            }
        };
        // SAFETY: Tauri supplies the live WebView2 controller on its owning thread.
        let started = unsafe {
            (|| -> windows::core::Result<()> {
                let core = platform.controller().CoreWebView2()?;
                let finish = reply.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result: windows::core::Result<()>, json: String| {
                        let Some(tx) = finish.lock().ok().and_then(|mut slot| slot.take()) else {
                            return Ok(());
                        };
                        if tx.is_closed() {
                            return Ok(());
                        }
                        let outcome = result.map(|()| json)
                            .map_err(|_| "The DevTools picture was not taken.".to_string());
                        let _ = tx.send(outcome);
                        Ok(())
                    },
                ));
                core.CallDevToolsProtocolMethod(
                    &HSTRING::from("Page.captureScreenshot"),
                    &HSTRING::from(r#"{"format":"png","fromSurface":true}"#),
                    &handler,
                )
            })()
        };
        if started.is_err() {
            fail("The DevTools picture could not be started.");
        }
    });
    if scheduled.is_err() {
        return Some(Err("The DevTools picture could not be started.".into()));
    }
    let json = match await_capture(receiver).await {
        Ok(json) => json,
        Err(error) => return Some(Err(error)),
    };
    Some(tauri::async_runtime::spawn_blocking(move || decode(json))
        .await
        .map_err(|_| "The DevTools picture could not be prepared.".to_string())
        .and_then(|result| result))
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn native_capture(_webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    Err("Screenshots are not available on this system.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> Rgba {
        Rgba { width, height, pixels: (0..width * height).flat_map(|_| rgba).collect() }
    }

    #[test]
    fn downscale_keeps_aspect_and_averages() {
        let mut image = solid(4, 2, [0, 0, 0, 255]);
        // Left half white, right half black.
        for y in 0..2 {
            for x in 0..2 {
                let i = ((y * 4 + x) * 4) as usize;
                image.pixels[i..i + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let small = downscale(&image, 2);
        assert_eq!((small.width, small.height), (2, 1));
        assert_eq!(&small.pixels[0..4], &[255, 255, 255, 255]);
        assert_eq!(&small.pixels[4..8], &[0, 0, 0, 255]);
        // Fractional scale: 3 → 2 blends the middle column.
        let mut three = solid(3, 1, [0, 0, 0, 255]);
        three.pixels[0..3].copy_from_slice(&[240, 240, 240]);
        let two = downscale(&three, 2);
        assert_eq!(two.width, 2);
        assert_eq!(two.pixels[0], 160);
        assert_eq!(two.pixels[4], 0);
    }

    #[test]
    fn transparent_pixels_do_not_darken_edges() {
        let mut image = solid(2, 1, [0, 0, 0, 0]);
        image.pixels[0..4].copy_from_slice(&[200, 100, 50, 255]);
        let one = downscale(&image, 1);
        assert_eq!(&one.pixels[0..3], &[200, 100, 50]);
        assert_eq!(one.pixels[3], 128);
    }

    #[test]
    fn shrink_caps_width_and_round_trips_png() {
        let native = encode_png(&solid(2880, 1800, [30, 40, 50, 255])).unwrap();
        let (png, width, height) = shrink_png(&native, MAX_WIDTH, MAX_PNG_BYTES).unwrap();
        assert_eq!((width, height), (1280, 800));
        assert!(png.len() <= MAX_PNG_BYTES);
        assert_eq!(&png[0..8], b"\x89PNG\r\n\x1a\n");
        let back = decode_png(&png).unwrap();
        assert_eq!((back.width, back.height), (1280, 800));
        assert_eq!(&back.pixels[0..4], &[30, 40, 50, 255]);
        // A small window is never enlarged.
        let tiny = encode_png(&solid(640, 400, [1, 2, 3, 255])).unwrap();
        assert_eq!(shrink_png(&tiny, MAX_WIDTH, MAX_PNG_BYTES).unwrap().1, 640);
    }

    #[test]
    fn shrink_steps_down_until_it_fits_and_rejects_garbage() {
        // Noise compresses badly: a tight byte cap forces narrower pictures.
        let mut seed = 7u32;
        let noise = Rgba {
            width: 1000,
            height: 600,
            pixels: (0..1000 * 600 * 4)
                .map(|_| {
                    seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                    (seed >> 16) as u8
                })
                .collect(),
        };
        let native = encode_png(&noise).unwrap();
        let (png, width, _) = shrink_png(&native, 900, 900_000).unwrap();
        assert!(width < 900, "{width}");
        assert!(png.len() <= 900_000);
        assert!(decode_png(b"not a png").is_err());
    }
}
