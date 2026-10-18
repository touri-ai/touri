use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{env, path::Path};

use tauri::{AppHandle, Manager, Runtime, Window};

pub const DEFAULT_WINDOW_SIZE: (u32, u32) = (1440, 900);
const MIN_WINDOW_SIZE: (f64, f64) = (960.0, 640.0);
static PLACEMENT_READY: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowPlacement {
    pub position: Option<(i32, i32)>,
    pub size: Option<(u32, u32)>,
}

/// Desktop coordinates in logical pixels, with the origin at the main display's
/// top-left. Never mix backing pixels from displays with different scale factors.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }

    fn intersection_area(self, other: Self) -> f64 {
        let width = (self.x + self.width).min(other.x + other.width) - self.x.max(other.x);
        let height = (self.y + self.height).min(other.y + other.height) - self.y.max(other.y);
        width.max(0.0) * height.max(0.0)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct DisplayFrame {
    pub bounds: Frame,
    pub visible: Frame,
    pub primary: bool,
}

impl DisplayFrame {
    pub fn from_physical(bounds: Frame, visible: Frame, scale: f64, primary: bool) -> Self {
        let logical = |frame: Frame| Frame {
            x: frame.x / scale,
            y: frame.y / scale,
            width: frame.width / scale,
            height: frame.height / scale,
        };
        Self {
            bounds: logical(bounds),
            visible: logical(visible),
            primary,
        }
    }
}

/// Keep the entire window on the display it intersects most. Discard stale
/// positions (including positions in gaps between displays), rather than
/// clamping them to the nearest disconnected display's former edge.
pub fn clamp_placement(
    position: Option<(f64, f64)>,
    size: (f64, f64),
    displays: &[DisplayFrame],
) -> Option<Frame> {
    let fallback = displays
        .iter()
        .filter(|display| display.bounds.valid() && display.visible.valid())
        .find(|display| display.primary)
        .or_else(|| {
            displays
                .iter()
                .find(|display| display.bounds.valid() && display.visible.valid())
        })?;
    let (width, height) =
        if size.0.is_finite() && size.1.is_finite() && size.0 > 0.0 && size.1 > 0.0 {
            size
        } else {
            (DEFAULT_WINDOW_SIZE.0 as f64, DEFAULT_WINDOW_SIZE.1 as f64)
        };
    let requested = position.map(|(x, y)| Frame {
        x,
        y,
        width,
        height,
    });
    let target = requested.filter(|frame| frame.valid()).and_then(|frame| {
        displays
            .iter()
            .filter(|display| display.bounds.valid() && display.visible.valid())
            .map(|display| (display, frame.intersection_area(display.bounds)))
            .filter(|(_, area)| *area > 0.0)
            .max_by(|(display_a, a), (display_b, b)| {
                a.total_cmp(b)
                    .then(display_a.primary.cmp(&display_b.primary))
            })
            .map(|(display, _)| display)
    });
    let visible = target.unwrap_or(fallback).visible;
    let width = width.min(visible.width);
    let height = height.min(visible.height);
    let (x, y) = match (target, position) {
        (Some(_), Some((x, y))) => (
            x.clamp(visible.x, visible.x + visible.width - width),
            y.clamp(visible.y, visible.y + visible.height - height),
        ),
        _ => (
            visible.x + (visible.width - width) / 2.0,
            visible.y + (visible.height - height) / 2.0,
        ),
    };
    Some(Frame {
        x,
        y,
        width,
        height,
    })
}

fn parse_pair<T>(value: Option<&str>, parse: impl Fn(&str) -> Option<T>) -> Option<(T, T)> {
    let mut parts = value?.split(',').map(str::trim);
    let first = parse(parts.next()?)?;
    let second = parse(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    Some((first, second))
}

pub fn parse_position(value: Option<&str>) -> Option<(i32, i32)> {
    parse_pair(value, |part| part.parse::<i32>().ok())
}

pub fn parse_size(value: Option<&str>) -> Option<(u32, u32)> {
    parse_pair(value, |part| {
        part.parse::<u32>().ok().filter(|size| *size > 0)
    })
}

pub fn from_env() -> WindowPlacement {
    WindowPlacement {
        position: parse_position(env::var("TOURI_WINDOW_POSITION").ok().as_deref()),
        size: parse_size(env::var("TOURI_WINDOW_SIZE").ok().as_deref()),
    }
}

fn merge_placement(overrides: WindowPlacement, saved: Option<WindowPlacement>) -> WindowPlacement {
    WindowPlacement {
        position: overrides
            .position
            .or_else(|| saved.as_ref().and_then(|state| state.position)),
        size: overrides
            .size
            .or_else(|| saved.and_then(|state| state.size))
            .or(Some(DEFAULT_WINDOW_SIZE)),
    }
}

fn read_placement(path: &Path) -> Option<WindowPlacement> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_placement(path: &Path, placement: &WindowPlacement) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec(placement)?)?;
    std::fs::rename(temporary, path)
}

pub fn restore<R: Runtime>(app: &AppHandle<R>) -> WindowPlacement {
    let saved = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| read_placement(&dir.join("window-placement.json")));
    merge_placement(from_env(), saved)
}

pub fn persist<R: Runtime>(window: &Window<R>) {
    if !PLACEMENT_READY.load(Ordering::Relaxed) {
        return;
    }
    // Minimized/fullscreen/maximized bounds are transient; retain normal bounds.
    if window.is_minimized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
        || window.is_maximized().unwrap_or(true)
    {
        return;
    }
    let save = || -> tauri::Result<()> {
        let scale = window.scale_factor()?;
        let position = window.outer_position()?.to_logical::<f64>(scale);
        let size = window.inner_size()?.to_logical::<f64>(scale);
        let placement = WindowPlacement {
            position: Some((position.x.round() as i32, position.y.round() as i32)),
            size: Some((size.width.round() as u32, size.height.round() as u32)),
        };
        write_placement(
            &window
                .app_handle()
                .path()
                .app_data_dir()?
                .join("window-placement.json"),
            &placement,
        )?;
        Ok(())
    };
    if let Err(error) = save() {
        eprintln!("[window] saving placement failed: {error}");
    }
}

fn display_frames<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Vec<DisplayFrame>> {
    let primary = app.primary_monitor()?;
    Ok(app
        .available_monitors()?
        .into_iter()
        .map(|monitor| {
            // Tao reports each macOS monitor's origin in that monitor's backing
            // pixels, so convert origins as well as sizes with its own scale.
            let scale = monitor.scale_factor();
            let position = monitor.position();
            let size = monitor.size();
            let work = monitor.work_area();
            DisplayFrame::from_physical(
                Frame {
                    x: position.x as f64,
                    y: position.y as f64,
                    width: size.width as f64,
                    height: size.height as f64,
                },
                Frame {
                    x: work.position.x as f64,
                    y: work.position.y as f64,
                    width: work.size.width as f64,
                    height: work.size.height as f64,
                },
                scale,
                primary
                    .as_ref()
                    .is_some_and(|primary| primary.position() == monitor.position()),
            )
        })
        .collect())
}

/// The OS owns the frame of a fullscreen, maximized or minimized window. Windows
/// draws a maximized frame past the work area by its border width and parks a
/// minimized one at -32000, so clamping either one resizes the window, fires
/// another Moved/Resized event and repairs it again, forever.
fn is_frame_owned_by_os(fullscreen: bool, maximized: bool, minimized: bool) -> bool {
    fullscreen || maximized || minimized
}

fn place_window<R: Runtime>(
    window: &Window<R>,
    initial: Option<WindowPlacement>,
) -> tauri::Result<()> {
    if is_frame_owned_by_os(
        window.is_fullscreen()?,
        window.is_maximized()?,
        window.is_minimized()?,
    ) {
        return Ok(());
    }
    let scale = window.scale_factor()?;
    let position = window.outer_position()?.to_logical::<f64>(scale);
    let outer = window.outer_size()?.to_logical::<f64>(scale);
    let inner = window.inner_size()?.to_logical::<f64>(scale);
    let border = (outer.width - inner.width, outer.height - inner.height);
    let (position, size) = match initial {
        Some(placement) => (
            placement.position.map(|(x, y)| (x as f64, y as f64)),
            placement
                .size
                .map_or((outer.width, outer.height), |(w, h)| {
                    (
                        (w as f64).max(MIN_WINDOW_SIZE.0) + border.0,
                        (h as f64).max(MIN_WINDOW_SIZE.1) + border.1,
                    )
                }),
        ),
        None => (Some((position.x, position.y)), (outer.width, outer.height)),
    };
    let displays = display_frames(window.app_handle())?;
    let Some(frame) = clamp_placement(position, size, &displays) else {
        return Ok(()); // Displays may temporarily be unavailable during sleep.
    };
    let minimum = (
        MIN_WINDOW_SIZE.0.min(frame.width - border.0),
        MIN_WINDOW_SIZE.1.min(frame.height - border.1),
    );
    #[cfg(target_os = "macos")]
    crate::platform::macos::window::apply_placement(window, minimum, frame)?;
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{LogicalPosition, LogicalSize};
        window.set_min_size(Some(LogicalSize::new(minimum.0, minimum.1)))?;
        if (inner.width, inner.height) != (frame.width - border.0, frame.height - border.1) {
            window.set_size(LogicalSize::new(
                frame.width - border.0,
                frame.height - border.1,
            ))?;
        }
        if position != Some((frame.x, frame.y)) {
            window.set_position(LogicalPosition::new(frame.x, frame.y))?;
        }
    }
    Ok(())
}

pub fn repair<R: Runtime>(window: &Window<R>) {
    if let Err(error) = place_window(window, None) {
        eprintln!("[window] placement recovery failed: {error}");
    }
}

/// Startup, Dock reopen, tray, second-instance and deep-link activation all use
/// this path. An auxiliary window being visible must not suppress main recovery.
pub fn show_main<R: Runtime>(app: &AppHandle<R>, initial: Option<WindowPlacement>) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(window) = handle.get_window("main") else {
            return;
        };
        if let Err(error) = crate::platform::unhide_app(&handle) {
            eprintln!("[window] unhide application failed: {error}");
        }
        if let Err(error) = window.unminimize() {
            eprintln!("[window] unminimize failed: {error}");
        }
        let placement = initial
            .or_else(|| (!PLACEMENT_READY.load(Ordering::Relaxed)).then(|| restore(&handle)));
        if let Err(error) = place_window(&window, placement) {
            eprintln!("[window] placement failed: {error}");
        }
        PLACEMENT_READY.store(true, Ordering::Relaxed);
        if let Err(error) = window.show().and_then(|_| window.set_focus()) {
            eprintln!("[window] show/focus failed: {error}");
        }
    }) {
        eprintln!("[window] dispatch recovery failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placement_roundtrips_and_environment_overrides_saved_fields_independently() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("r4-placement-test-{}", std::process::id()));
        let path = dir.join("window-placement.json");
        let saved = WindowPlacement {
            position: Some((-1800, -100)),
            size: Some((1200, 800)),
        };
        write_placement(&path, &saved).unwrap();
        assert_eq!(read_placement(&path), Some(saved.clone()));
        assert_eq!(
            merge_placement(
                WindowPlacement {
                    position: None,
                    size: None
                },
                read_placement(&path)
            ),
            saved
        );
        assert_eq!(
            merge_placement(
                WindowPlacement {
                    position: None,
                    size: Some((1440, 900))
                },
                Some(saved)
            ),
            WindowPlacement {
                position: Some((-1800, -100)),
                size: Some((1440, 900))
            }
        );
        std::fs::write(&path, b"corrupt state").unwrap();
        assert_eq!(read_placement(&path), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn frame(x: f64, y: f64, width: f64, height: f64) -> Frame {
        Frame {
            x,
            y,
            width,
            height,
        }
    }

    fn displays() -> [DisplayFrame; 2] {
        [
            DisplayFrame {
                bounds: frame(0.0, 0.0, 1512.0, 982.0),
                visible: frame(0.0, 33.0, 1512.0, 949.0),
                primary: true,
            },
            DisplayFrame {
                bounds: frame(-1920.0, -251.0, 1920.0, 1080.0),
                visible: frame(-1920.0, -226.0, 1920.0, 1055.0),
                primary: false,
            },
        ]
    }

    #[test]
    fn requested_external_position_and_size_use_logical_pixels() {
        assert_eq!(
            clamp_placement(Some((-1920.0, -251.0)), (1600.0, 1000.0), &displays()),
            Some(frame(-1920.0, -226.0, 1600.0, 1000.0)),
        );
    }

    #[test]
    fn mixed_dpi_frames_convert_origins_and_sizes_per_display() {
        let retina = DisplayFrame::from_physical(
            frame(0.0, 0.0, 3024.0, 1964.0),
            frame(0.0, 66.0, 3024.0, 1898.0),
            2.0,
            true,
        );
        let external = DisplayFrame::from_physical(
            frame(-1920.0, -251.0, 1920.0, 1080.0),
            frame(-1920.0, -226.0, 1920.0, 1055.0),
            1.0,
            false,
        );
        assert_eq!(retina.bounds, displays()[0].bounds);
        assert_eq!(retina.visible, displays()[0].visible);
        assert_eq!(external.bounds, displays()[1].bounds);
        assert_eq!(external.visible, displays()[1].visible);
        assert_eq!(
            clamp_placement(
                Some((-1920.0, -251.0)),
                (1600.0, 1000.0),
                &[retina, external]
            ),
            Some(frame(-1920.0, -226.0, 1600.0, 1000.0)),
        );
        let left_retina = DisplayFrame::from_physical(
            frame(-3840.0, -502.0, 3840.0, 2160.0),
            frame(-3840.0, -452.0, 3840.0, 2110.0),
            2.0,
            false,
        );
        assert_eq!(left_retina.bounds, external.bounds);
        assert_eq!(left_retina.visible, external.visible);
    }

    #[test]
    fn recovery_is_idempotent_and_fits_a_display_smaller_than_minimum_size() {
        let small = [DisplayFrame {
            bounds: frame(0.0, 0.0, 800.0, 600.0),
            visible: frame(0.0, 25.0, 800.0, 535.0),
            primary: true,
        }];
        let repaired = clamp_placement(Some((-1920.0, -251.0)), (1600.0, 1000.0), &small).unwrap();
        assert_eq!(repaired, small[0].visible);
        assert_eq!(
            clamp_placement(
                Some((repaired.x, repaired.y)),
                (repaired.width, repaired.height),
                &small
            ),
            Some(repaired)
        );
    }

    #[test]
    fn valid_saved_external_placement_is_preserved() {
        let saved = frame(-1800.0, -100.0, 1440.0, 900.0);
        assert_eq!(
            clamp_placement(
                Some((saved.x, saved.y)),
                (saved.width, saved.height),
                &displays()
            ),
            Some(saved)
        );
    }

    #[test]
    fn disconnected_display_position_is_discarded() {
        assert_eq!(
            clamp_placement(Some((-1920.0, -251.0)), (1440.0, 900.0), &displays()[..1]),
            Some(frame(36.0, 57.5, 1440.0, 900.0)),
        );
    }

    #[test]
    fn missing_position_centers_on_primary_even_when_it_is_not_first() {
        let mut displays = displays();
        displays.reverse();
        assert_eq!(
            clamp_placement(None, (1440.0, 900.0), &displays),
            Some(frame(36.0, 57.5, 1440.0, 900.0))
        );
    }

    #[test]
    fn partially_offscreen_window_is_fully_clamped() {
        assert_eq!(
            clamp_placement(Some((1450.0, 900.0)), (800.0, 500.0), &displays()),
            Some(frame(712.0, 482.0, 800.0, 500.0))
        );
    }

    #[test]
    fn straddling_window_uses_the_largest_intersection() {
        assert_eq!(
            clamp_placement(Some((-760.0, 33.0)), (1440.0, 900.0), &displays()),
            Some(frame(0.0, 33.0, 1440.0, 900.0))
        );
    }

    #[test]
    fn oversized_window_fits_visible_frame_including_dock() {
        let mut displays = displays();
        displays[0].visible = frame(80.0, 33.0, 1432.0, 879.0);
        assert_eq!(
            clamp_placement(Some((10.0, 10.0)), (10000.0, 10000.0), &displays),
            Some(displays[0].visible)
        );
    }

    #[test]
    fn position_in_a_display_gap_or_touching_an_edge_is_discarded() {
        let displays = &displays()[..1];
        for position in [(1512.0, 33.0), (-800.0, 33.0), (100.0, -600.0)] {
            assert_eq!(
                clamp_placement(Some(position), (800.0, 500.0), displays),
                Some(frame(356.0, 257.5, 800.0, 500.0))
            );
        }
    }

    #[test]
    fn invalid_frames_and_nonfinite_requests_are_safe() {
        assert_eq!(clamp_placement(None, (800.0, 500.0), &[]), None);
        let mut displays = displays();
        displays[0].visible.width = 0.0;
        assert_eq!(
            clamp_placement(None, (800.0, 500.0), &displays),
            Some(frame(-1360.0, 51.5, 800.0, 500.0))
        );
        assert_eq!(
            clamp_placement(
                Some((f64::NAN, f64::INFINITY)),
                (f64::INFINITY, 0.0),
                &displays[1..]
            ),
            Some(frame(-1680.0, -148.5, 1440.0, 900.0))
        );
    }

    #[test]
    fn maximized_and_minimized_frames_are_left_to_the_os() {
        // Windows at 125%: a maximized frame overhangs the 1536x816 work area by its border,
        // so clamping it would always produce a different frame and resize the window.
        let display = [DisplayFrame {
            bounds: frame(0.0, 0.0, 1536.0, 864.0),
            visible: frame(0.0, 0.0, 1536.0, 816.0),
            primary: true,
        }];
        let maximized = frame(-8.0, -8.0, 1552.0, 832.0);

        let clamped = clamp_placement(
            Some((maximized.x, maximized.y)),
            (maximized.width, maximized.height),
            &display,
        );

        assert_ne!(clamped, Some(maximized));
        assert!(is_frame_owned_by_os(false, true, false));
        assert!(is_frame_owned_by_os(false, false, true));
        assert!(is_frame_owned_by_os(true, false, false));
        assert!(!is_frame_owned_by_os(false, false, false));
    }
}
