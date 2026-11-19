//! A picture of the app window for the theme tool `capture_app_screenshot`.
//!
//! The picture comes from the app's own webview, never from the screen:
//! WKWebView `takeSnapshotWithConfiguration:` on macOS and WebView2
//! `CapturePreview` on Windows. Neither is screen recording, so no system
//! permission (Screen Recording, ScreenCaptureKit) is ever involved, and
//! other apps' windows can never appear in it. Other platforms report that
//! screenshots are not available.
//!
//! The renderer asks for it only after checking "Theme tools in chats" and
//! "Let models see the app"; the native half just takes and shrinks it.

use base64::Engine;
use serde_json::{json, Value};

/// Widest picture sent to a model, in pixels.
pub(crate) const MAX_WIDTH: u32 = 1280;
/// Largest PNG sent to a model; wider steps down until it fits.
pub(crate) const MAX_PNG_BYTES: usize = 1_200_000;
/// Largest native PNG accepted before shrinking (a 6K window is ~40 MB raw).
const MAX_NATIVE_PNG_BYTES: usize = 64 * 1024 * 1024;
const MAX_NATIVE_PIXELS: u64 = 8192 * 8192;
static CAPTURE_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// Take a picture of the calling webview and return it as a downscaled PNG:
/// `{ mimeType: "image/png", data: <base64>, width, height }`.
#[tauri::command]
pub(crate) async fn capture_app_window(webview: tauri::Webview) -> Result<Value, String> {
    // Each provider can issue parallel tool calls. The app only needs one native
    // snapshot and PNG conversion at a time.
    let _capture_slot = CAPTURE_SLOT
        .try_acquire()
        .map_err(|_| "Another window picture is being prepared.".to_string())?;
    let native = native_capture(&webview).await?;
    let (png, width, height) = tauri::async_runtime::spawn_blocking(move || shrink_png(&native, MAX_WIDTH, MAX_PNG_BYTES))
        .await
        .map_err(|_| "The picture could not be prepared.".to_string())??;
    Ok(json!({
        "mimeType": "image/png",
        "data": base64::engine::general_purpose::STANDARD.encode(&png),
        "width": width,
        "height": height,
    }))
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
pub(crate) fn shrink_png(native: &[u8], max_width: u32, max_bytes: usize) -> Result<(Vec<u8>, u32, u32), String> {
    let image = decode_png(native)?;
    let mut width = image.width.min(max_width);
    loop {
        let small = downscale(&image, width);
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

const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

async fn await_capture(receiver: tokio::sync::oneshot::Receiver<Result<Vec<u8>, String>>) -> Result<Vec<u8>, String> {
    match tokio::time::timeout(CAPTURE_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The window did not return a picture.".into()),
        Err(_) => Err("The window did not return a picture in time.".into()),
    }
}

#[cfg(target_os = "macos")]
async fn native_capture(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    // WebKit takes a width in points. Ask it to scale large views before the
    // completion handler converts the image on the UI thread.
    let snapshot_width = webview
        .size()
        .ok()
        .filter(|size| size.width > MAX_WIDTH)
        .and_then(|_| webview.window().scale_factor().ok())
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .map(|scale| f64::from(MAX_WIDTH) / scale);
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let reply = std::sync::Arc::new(Mutex::new(Some(sender)));
    let scheduled = webview.with_webview(move |platform| {
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
            let view = &*(platform.inner() as *const WKWebView);
            let config = WKSnapshotConfiguration::new(mtm);
            if let Some(width) = snapshot_width {
                config.setSnapshotWidth(Some(&NSNumber::numberWithDouble(width)));
            }
            // WebKit waits for pending paints by default.
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
    use std::sync::Mutex;

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
            bytes.truncate(read as usize);
            Ok(bytes)
        }
    }

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let reply = std::sync::Arc::new(Mutex::new(Some(sender)));
    let scheduled = webview.with_webview(move |platform| {
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
