use crate::window_config::Frame;
use tauri::{AppHandle, Manager, Runtime, Window};
pub fn apply_placement<R: Runtime>(
    window: &Window<R>,
    minimum: (f64, f64),
    frame: Frame,
) -> tauri::Result<()> {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

    assert!(
        MainThreadMarker::new().is_some(),
        "placement must run on the main thread"
    );
    // SAFETY: Tauri owns this NSWindow and keeps it alive for this call. All
    // callers dispatch to the main thread before accessing AppKit.
    let native = unsafe { &*window.ns_window()?.cast::<NSWindow>() };
    native.setContentMinSize(NSSize::new(minimum.0, minimum.1));
    // Apply size and position atomically in AppKit points. Tao's setters
    // enqueue separate GCD operations; a display/DPI change between those
    // operations otherwise exposes an intermediate, incorrectly placed frame.
    let top = core_graphics::display::CGDisplay::main().pixels_high() as f64;
    let desired = NSRect::new(
        NSPoint::new(frame.x, top - frame.y - frame.height),
        NSSize::new(frame.width, frame.height),
    );
    if native.frame() != desired {
        native.setFrame_display(desired, true);
    }
    Ok(())
}
pub fn observe_display_changes<R: Runtime>(app: &AppHandle<R>) {
    use block2::RcBlock;
    use objc2_app_kit::NSApplicationDidChangeScreenParametersNotification;
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use std::ptr::NonNull;

    let handle = app.clone();
    let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            for window in app.windows().values() {
                crate::window_config::repair(window);
            }
        });
    });
    // The center retains this registration for the process lifetime, just like
    // the power monitor. It never creates a window or changes window visibility.
    let _observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidChangeScreenParametersNotification),
            None,
            None,
            &block,
        )
    };
}

pub fn log_native_windows<R: Runtime>(app: &AppHandle<R>) {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let managed: Vec<_> = app
        .windows()
        .values()
        .filter_map(|w| w.ns_window().ok())
        .collect();
    for window in NSApplication::sharedApplication(mtm).windows().iter() {
        let owned = managed.contains(&(std::ptr::from_ref(&*window).cast_mut().cast()));
        eprintln!(
            "[window] native class={} title={:?} frame={:?} visible={} managed={owned}",
            window.class().name().to_string_lossy(),
            window.title(),
            window.frame(),
            window.isVisible(),
        );
    }
}
