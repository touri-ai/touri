#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
use super::HostError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct ScreenshotParams {
    #[serde(rename = "displayId")]
    display_id: Option<u32>,
    #[serde(rename = "maxWidth")]
    max_width: Option<u32>,
    region: Option<Region>,
}

#[derive(Debug, Serialize)]
struct ScreenshotResult {
    #[serde(rename = "dataBase64")]
    data_base64: String,
    mime: &'static str,
    width: usize,
    height: usize,
    scale: f64,
    #[serde(rename = "displayId")]
    display_id: u32,
}

pub fn image_to_global(mapping: (f64, f64, f64), image_x: f64, image_y: f64) -> (f64, f64) {
    let (origin_x, origin_y, scale) = mapping;
    (origin_x + image_x / scale, origin_y + image_y / scale)
}

#[cfg(target_os = "macos")]
#[path = "../platform/macos/computer_capture.rs"]
mod macos;

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::HostError;
    use serde_json::Value;

    pub(super) fn screenshot(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
}

pub fn screenshot(params: &Value) -> Result<Value, HostError> {
    macos::screenshot(params)
}

#[cfg(test)]
mod tests {
    use super::image_to_global;

    #[test]
    fn retina_image_coordinates_map_back_to_global_points() {
        assert_eq!(
            image_to_global((100.0, 40.0, 2.0), 200.0, 80.0),
            (200.0, 80.0)
        );
    }
}
