use super::{Region, ScreenshotParams, ScreenshotResult};
use crate::computer::hud;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use screencapturekit::cg::CGRect;
use screencapturekit::screenshot_manager::{CGImageExt, ImageFormat, SCScreenshotManager};
use screencapturekit::shareable_content::SCShareableContent;
use screencapturekit::stream::configuration::SCStreamConfiguration;
use screencapturekit::stream::content_filter::SCContentFilter;
use serde_json::Value;
use std::fs::{read, remove_file};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn temp_path() -> PathBuf {
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("touri-computer-{}-{id}.png", std::process::id()))
}

fn capture(params: ScreenshotParams) -> Result<ScreenshotResult, super::HostError> {
    let content =
        SCShareableContent::get().map_err(|error| super::HostError::Native(error.to_string()))?;
    let display = content
        .displays()
        .into_iter()
        .find(|candidate| {
            params
                .display_id
                .is_none_or(|id| candidate.display_id() == id)
        })
        .ok_or_else(|| super::HostError::Native("requested display was not found".to_string()))?;
    let frame = display.frame();
    let source = params.region.unwrap_or(Region {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    });
    if source.width <= 0.0 || source.height <= 0.0 {
        return Err(super::HostError::InvalidParams(
            "region must have positive dimensions".to_string(),
        ));
    }
    let display_scale = f64::from(display.width()) / frame.size.width;
    let native_width = (source.width * display_scale).round().max(1.0);
    let requested_width = f64::from(params.max_width.unwrap_or(1440).clamp(640, 2560));
    let output_width = native_width.min(requested_width).round().max(1.0) as u32;
    let output_height = (f64::from(output_width) * source.height / source.width)
        .round()
        .max(1.0) as u32;
    let scale = f64::from(output_width) / source.width;

    let windows = content.windows();
    let excluded = windows
        .iter()
        .filter(|window| {
            window
                .owning_application()
                .map(|application| application.bundle_identifier() == "ai.touri.desktop")
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&excluded)
        .build()
        .map_err(|error| super::HostError::Native(error.to_string()))?;
    let config = SCStreamConfiguration::new()
        .with_width(output_width)
        .with_height(output_height)
        .with_source_rect(CGRect::new(source.x, source.y, source.width, source.height))
        .with_scales_to_fit(true)
        .with_shows_cursor(true);

    hud::hide_and_wait();
    let image = SCScreenshotManager::capture_image(&filter, &config)
        .map_err(|error| super::HostError::Native(error.to_string()));
    let result = image.and_then(|image| {
        let path = temp_path();
        let save = image
            .save(path.to_string_lossy().as_ref(), ImageFormat::Png)
            .map_err(|error| super::HostError::Native(error.to_string()));
        let result = save.and_then(|_| {
            read(&path)
                .map(|bytes| ScreenshotResult {
                    data_base64: STANDARD.encode(bytes),
                    mime: "image/png",
                    width: image.width(),
                    height: image.height(),
                    scale,
                    display_id: display.display_id(),
                })
                .map_err(|error| super::HostError::Native(error.to_string()))
        });
        let _ = remove_file(path);
        result
    });
    hud::restore();
    result
}

pub(super) fn screenshot(params: &Value) -> Result<Value, super::HostError> {
    let parsed: ScreenshotParams = serde_json::from_value(params.clone())
        .map_err(|error| super::HostError::InvalidParams(error.to_string()))?;
    let result = capture(parsed)?;
    serde_json::to_value(result).map_err(|error| super::HostError::Native(error.to_string()))
}
