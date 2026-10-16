use super::HostError;
use serde_json::Value;

const SYNTHETIC_INPUT_MARKER: i64 = 0x746f757269;

fn is_synthetic_input(marker: i64) -> bool {
    marker == SYNTHETIC_INPUT_MARKER
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modifier {
    Cmd,
    Shift,
    Alt,
    Ctrl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCombo {
    pub modifiers: Vec<Modifier>,
    pub key: String,
}

pub fn parse_key_combo(combo: &str) -> Result<KeyCombo, HostError> {
    let pieces: Vec<&str> = combo.split('+').collect();
    let Some(key) = pieces.last().copied() else {
        return Err(HostError::InvalidParams("key combo is empty".to_string()));
    };
    if key.is_empty()
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '.')
    {
        return Err(HostError::InvalidParams(
            "key combo contains an invalid key".to_string(),
        ));
    }
    let mut modifiers = Vec::new();
    for modifier in pieces.iter().take(pieces.len().saturating_sub(1)) {
        let parsed = match *modifier {
            "cmd" => Modifier::Cmd,
            "shift" => Modifier::Shift,
            "alt" => Modifier::Alt,
            "ctrl" => Modifier::Ctrl,
            _ => {
                return Err(HostError::InvalidParams(format!(
                    "unknown key modifier: {modifier}"
                )))
            }
        };
        if modifiers.contains(&parsed) {
            return Err(HostError::InvalidParams(
                "key combo repeats a modifier".to_string(),
            ));
        }
        modifiers.push(parsed);
    }
    Ok(KeyCombo {
        modifiers,
        key: key.to_ascii_lowercase(),
    })
}

fn protected_application(pid: i32, bundle: &str, name: &str) -> bool {
    pid == std::process::id() as i32
        || matches!(
            bundle,
            "ai.touri.desktop" | "com.apple.systempreferences" | "com.apple.SecurityAgent"
        )
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "touri" | "system settings" | "system preferences"
        )
}

fn contains_point(bounds: (f64, f64, f64, f64), point: (f64, f64)) -> bool {
    let (x, y, width, height) = bounds;
    point.0 >= x && point.1 >= y && point.0 <= x + width && point.1 <= y + height
}

fn terminal_application(bundle: &str, name: &str) -> bool {
    let identity = format!("{bundle} {name}").to_ascii_lowercase();
    [
        "terminal",
        "iterm",
        "warp",
        "alacritty",
        "kitty",
        "wezterm",
        "ghostty",
        "hyper",
        "tabby",
        "termius",
        "termora",
    ]
    .iter()
    .any(|term| identity.contains(term))
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{HostError, Modifier};
    use block2::RcBlock;
    use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex};
    use core_foundation::base::{CFRelease, TCFType};
    use core_foundation::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
    use core_foundation::number::{kCFNumberSInt64Type, CFNumberGetValue};
    use core_foundation::string::CFString;
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField, KeyCode,
        ScrollEventUnit,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use core_graphics::window::{
        kCGNullWindowID, kCGWindowListOptionOnScreenOnly, CGWindowListCopyWindowInfo,
    };
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};
    use serde_json::Value;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};

    static CONSENT_GUARD_READY: AtomicBool = AtomicBool::new(false);

    extern "C" {
        fn CGRectMakeWithDictionaryRepresentation(dict: CFDictionaryRef, rect: *mut CGRect)
            -> bool;
        fn CGEventGetIntegerValueField(event: *const c_void, field: u32) -> i64;
    }

    pub(super) fn install_consent_guard() {
        if CONSENT_GUARD_READY.load(Ordering::SeqCst) {
            return;
        }
        // AppKit runs this monitor on the main thread before dispatch to any touri
        // window, including consent/settings. The marker survives CGEvent delivery,
        // so a focus/geometry change after the preflight cannot approve a card.
        let handler = RcBlock::new(|event: *mut AnyObject| -> *mut AnyObject {
            if event.is_null() {
                return event;
            }
            unsafe {
                let cg: *const c_void = msg_send![event, CGEvent];
                if !cg.is_null()
                    && super::is_synthetic_input(CGEventGetIntegerValueField(
                        cg,
                        EventField::EVENT_SOURCE_USER_DATA,
                    ))
                {
                    return std::ptr::null_mut();
                }
            }
            event
        });
        unsafe {
            let monitor: *mut AnyObject = msg_send![
                class!(NSEvent),
                addLocalMonitorForEventsMatchingMask: usize::MAX,
                handler: &*handler
            ];
            if let Some(monitor) = Retained::retain(monitor) {
                // One monitor for the application lifetime. AppKit copies the block.
                std::mem::forget(monitor);
                CONSENT_GUARD_READY.store(true, Ordering::SeqCst);
            }
        }
    }

    fn post_checked(
        event: &CGEvent,
        point: Option<CGPoint>,
        params: Option<(&Value, &str)>,
    ) -> Result<(), HostError> {
        event.set_integer_value_field(
            EventField::EVENT_SOURCE_USER_DATA,
            super::SYNTHETIC_INPUT_MARKER,
        );
        guard_target(point, params)?;
        event.post(CGEventTapLocation::HID);
        Ok(())
    }

    // Check immediately before every event, including each chunk and mouse-up. Failure to
    // inspect the current desktop fails closed. Never trust model-supplied window metadata.
    fn guard_target(
        point: Option<CGPoint>,
        params: Option<(&Value, &str)>,
    ) -> Result<(), HostError> {
        let blocked = || {
            HostError::Native(
                "O controle automático não pode operar o touri nem controles de consentimento"
                    .to_string(),
            )
        };
        let app = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .ok_or_else(blocked)?;
        let bundle = app
            .bundleIdentifier()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let name = app
            .localizedName()
            .map(|s| s.to_string())
            .unwrap_or_default();
        if point.is_none() && super::protected_application(app.processIdentifier(), &bundle, &name)
        {
            return Err(blocked());
        }
        if let Some((params, tool)) = params {
            if super::terminal_application(&bundle, &name) {
                let approval = &params["terminalApproval"];
                let field = if tool == "computer_type" {
                    "text"
                } else {
                    "combo"
                };
                if approval["tool"].as_str() != Some(tool)
                    || approval["target"]["bundleId"].as_str() != Some(bundle.as_str())
                    || approval["target"]["app"].as_str() != Some(name.as_str())
                    || approval["target"]["processId"].as_i64()
                        != Some(i64::from(app.processIdentifier()))
                    || approval["input"][field] != params[field]
                    || !params[field].is_string()
                {
                    return Err(HostError::Native(
                        "Esta ação no terminal exige aprovação humana específica".to_string(),
                    ));
                }
            }
        }
        if let Some(point) = point {
            if !point.x.is_finite() || !point.y.is_finite() {
                return Err(blocked());
            }
            for bounds in protected_regions()? {
                if super::contains_point(bounds, (point.x, point.y)) {
                    return Err(blocked());
                }
            }
        }
        Ok(())
    }

    pub(super) fn protected_regions() -> Result<Vec<(f64, f64, f64, f64)>, HostError> {
        let unavailable =
            || HostError::Native("Não foi possível verificar as janelas protegidas".to_string());
        // Quartz coordinates match CGEvent global points on all displays, including Retina.
        unsafe {
            let windows =
                CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
            if windows.is_null() {
                return Err(unavailable());
            }
            let result = (|| {
                let mut regions = Vec::new();
                for i in 0..CFArrayGetCount(windows) {
                    let row = CFArrayGetValueAtIndex(windows, i) as CFDictionaryRef;
                    let pid_value = CFDictionaryGetValue(
                        row,
                        CFString::new("kCGWindowOwnerPID").as_CFTypeRef(),
                    );
                    let mut pid: i64 = 0;
                    if pid_value.is_null()
                        || !CFNumberGetValue(
                            pid_value.cast(),
                            kCFNumberSInt64Type,
                            (&mut pid as *mut i64).cast::<c_void>(),
                        )
                    {
                        return Err(unavailable());
                    }
                    let owner =
                        NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32);
                    let bundle = owner
                        .as_ref()
                        .and_then(|a| a.bundleIdentifier())
                        .map(|s| s.to_string())
                        .unwrap_or_default();
                    let name = owner
                        .as_ref()
                        .and_then(|a| a.localizedName())
                        .map(|s| s.to_string())
                        .unwrap_or_default();
                    if !super::protected_application(pid as i32, &bundle, &name) {
                        continue;
                    }
                    let value =
                        CFDictionaryGetValue(row, CFString::new("kCGWindowBounds").as_CFTypeRef());
                    let mut rect = CGRect::new(&CGPoint::new(0.0, 0.0), &CGSize::new(0.0, 0.0));
                    if value.is_null()
                        || !CGRectMakeWithDictionaryRepresentation(value.cast(), &mut rect)
                    {
                        return Err(unavailable());
                    }
                    regions.push((
                        rect.origin.x,
                        rect.origin.y,
                        rect.size.width,
                        rect.size.height,
                    ));
                }
                Ok(regions)
            })();
            CFRelease(windows.cast());
            result
        }
    }

    fn source() -> Result<CGEventSource, HostError> {
        if !CONSENT_GUARD_READY.load(Ordering::SeqCst) {
            return Err(HostError::Native(
                "A proteção dos controles de consentimento não está disponível".to_string(),
            ));
        }
        CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| HostError::Native("could not create an input event source".to_string()))
    }

    fn key_code(key: &str) -> Option<u16> {
        let code = match key {
            "a" => KeyCode::ANSI_A,
            "b" => KeyCode::ANSI_B,
            "c" => KeyCode::ANSI_C,
            "d" => KeyCode::ANSI_D,
            "e" => KeyCode::ANSI_E,
            "f" => KeyCode::ANSI_F,
            "g" => KeyCode::ANSI_G,
            "h" => KeyCode::ANSI_H,
            "i" => KeyCode::ANSI_I,
            "j" => KeyCode::ANSI_J,
            "k" => KeyCode::ANSI_K,
            "l" => KeyCode::ANSI_L,
            "m" => KeyCode::ANSI_M,
            "n" => KeyCode::ANSI_N,
            "o" => KeyCode::ANSI_O,
            "p" => KeyCode::ANSI_P,
            "q" => KeyCode::ANSI_Q,
            "r" => KeyCode::ANSI_R,
            "s" => KeyCode::ANSI_S,
            "t" => KeyCode::ANSI_T,
            "u" => KeyCode::ANSI_U,
            "v" => KeyCode::ANSI_V,
            "w" => KeyCode::ANSI_W,
            "x" => KeyCode::ANSI_X,
            "y" => KeyCode::ANSI_Y,
            "z" => KeyCode::ANSI_Z,
            "0" => KeyCode::ANSI_0,
            "1" => KeyCode::ANSI_1,
            "2" => KeyCode::ANSI_2,
            "3" => KeyCode::ANSI_3,
            "4" => KeyCode::ANSI_4,
            "5" => KeyCode::ANSI_5,
            "6" => KeyCode::ANSI_6,
            "7" => KeyCode::ANSI_7,
            "8" => KeyCode::ANSI_8,
            "9" => KeyCode::ANSI_9,
            "return" | "enter" => KeyCode::RETURN,
            "tab" => KeyCode::TAB,
            "space" => KeyCode::SPACE,
            "delete" | "backspace" => KeyCode::DELETE,
            "escape" | "esc" => KeyCode::ESCAPE,
            "period" | "." => KeyCode::ANSI_PERIOD,
            "left" => KeyCode::LEFT_ARROW,
            "right" => KeyCode::RIGHT_ARROW,
            "up" => KeyCode::UP_ARROW,
            "down" => KeyCode::DOWN_ARROW,
            _ => return None,
        };
        Some(code)
    }

    fn modifier_code(modifier: Modifier) -> u16 {
        match modifier {
            Modifier::Cmd => KeyCode::COMMAND,
            Modifier::Shift => KeyCode::SHIFT,
            Modifier::Alt => KeyCode::OPTION,
            Modifier::Ctrl => KeyCode::CONTROL,
        }
    }

    fn modifier_flag(modifier: Modifier) -> CGEventFlags {
        match modifier {
            Modifier::Cmd => CGEventFlags::CGEventFlagCommand,
            Modifier::Shift => CGEventFlags::CGEventFlagShift,
            Modifier::Alt => CGEventFlags::CGEventFlagAlternate,
            Modifier::Ctrl => CGEventFlags::CGEventFlagControl,
        }
    }

    fn post_key(
        source: &CGEventSource,
        code: u16,
        down: bool,
        flags: CGEventFlags,
        params: &Value,
    ) -> Result<(), HostError> {
        let event = CGEvent::new_keyboard_event(source.clone(), code, down)
            .map_err(|_| HostError::Native("could not create keyboard event".to_string()))?;
        event.set_flags(flags);
        post_checked(&event, None, Some((params, "computer_key")))?;
        Ok(())
    }

    pub(super) fn click(params: &Value) -> Result<Value, HostError> {
        let generation = crate::computer::input_generation()?;
        let x = params
            .get("x")
            .and_then(Value::as_f64)
            .ok_or_else(|| HostError::InvalidParams("x is required".to_string()))?;
        let y = params
            .get("y")
            .and_then(Value::as_f64)
            .ok_or_else(|| HostError::InvalidParams("y is required".to_string()))?;
        let button = match params
            .get("button")
            .and_then(Value::as_str)
            .unwrap_or("left")
        {
            "left" => CGMouseButton::Left,
            "right" => CGMouseButton::Right,
            "middle" => CGMouseButton::Center,
            _ => return Err(HostError::InvalidParams("unknown mouse button".to_string())),
        };
        let click_count = params
            .get("clickCount")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 3) as i64;
        let modifiers = params
            .get("modifiers")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(|value| match value {
                        "cmd" => Some(Modifier::Cmd),
                        "shift" => Some(Modifier::Shift),
                        "alt" => Some(Modifier::Alt),
                        "ctrl" => Some(Modifier::Ctrl),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let flags = modifiers
            .iter()
            .fold(CGEventFlags::empty(), |flags, modifier| {
                flags | modifier_flag(*modifier)
            });
        let source = source()?;
        let point = CGPoint::new(x, y);
        let down_type = match button {
            CGMouseButton::Left => CGEventType::LeftMouseDown,
            CGMouseButton::Right => CGEventType::RightMouseDown,
            CGMouseButton::Center => CGEventType::OtherMouseDown,
        };
        let up_type = match button {
            CGMouseButton::Left => CGEventType::LeftMouseUp,
            CGMouseButton::Right => CGEventType::RightMouseUp,
            CGMouseButton::Center => CGEventType::OtherMouseUp,
        };
        let down = CGEvent::new_mouse_event(source.clone(), down_type, point, button)
            .map_err(|_| HostError::Native("could not create mouse event".to_string()))?;
        down.set_flags(flags);
        down.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_count);
        crate::computer::ensure_input_generation(generation)?;
        post_checked(&down, Some(point), None)?;
        let up = CGEvent::new_mouse_event(source, up_type, point, button)
            .map_err(|_| HostError::Native("could not create mouse event".to_string()))?;
        up.set_flags(flags);
        up.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_count);
        crate::computer::ensure_input_generation(generation)?;
        post_checked(&up, Some(point), None)?;
        Ok(serde_json::json!({}))
    }

    pub(super) fn move_pointer(params: &Value) -> Result<Value, HostError> {
        let generation = crate::computer::input_generation()?;
        let x = params
            .get("x")
            .and_then(Value::as_f64)
            .ok_or_else(|| HostError::InvalidParams("x is required".to_string()))?;
        let y = params
            .get("y")
            .and_then(Value::as_f64)
            .ok_or_else(|| HostError::InvalidParams("y is required".to_string()))?;
        let event = CGEvent::new_mouse_event(
            source()?,
            CGEventType::MouseMoved,
            CGPoint::new(x, y),
            CGMouseButton::Left,
        )
        .map_err(|_| HostError::Native("could not create mouse event".to_string()))?;
        crate::computer::ensure_input_generation(generation)?;
        post_checked(&event, Some(CGPoint::new(x, y)), None)?;
        Ok(serde_json::json!({}))
    }

    pub(super) fn type_text(params: &Value) -> Result<Value, HostError> {
        let text = params
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| HostError::InvalidParams("text is required".to_string()))?;
        let source = source()?;
        for chunk in text.encode_utf16().collect::<Vec<_>>().chunks(64) {
            let generation = crate::computer::input_generation()?;
            let down = CGEvent::new_keyboard_event(source.clone(), 0, true)
                .map_err(|_| HostError::Native("could not create keyboard event".to_string()))?;
            down.set_string_from_utf16_unchecked(chunk);
            crate::computer::ensure_input_generation(generation)?;
            post_checked(&down, None, Some((params, "computer_type")))?;
            let up = CGEvent::new_keyboard_event(source.clone(), 0, false)
                .map_err(|_| HostError::Native("could not create keyboard event".to_string()))?;
            crate::computer::ensure_input_generation(generation)?;
            post_checked(&up, None, Some((params, "computer_type")))?;
        }
        Ok(serde_json::json!({}))
    }

    pub(super) fn key(params: &Value) -> Result<Value, HostError> {
        let generation = crate::computer::input_generation()?;
        let combo = params
            .get("combo")
            .and_then(Value::as_str)
            .ok_or_else(|| HostError::InvalidParams("combo is required".to_string()))?;
        let parsed = super::parse_key_combo(combo)?;
        let code = key_code(&parsed.key)
            .ok_or_else(|| HostError::InvalidParams(format!("unknown key: {}", parsed.key)))?;
        let source = source()?;
        let flags = parsed
            .modifiers
            .iter()
            .fold(CGEventFlags::empty(), |flags, modifier| {
                flags | modifier_flag(*modifier)
            });
        for modifier in &parsed.modifiers {
            crate::computer::ensure_input_generation(generation)?;
            post_key(
                &source,
                modifier_code(*modifier),
                true,
                modifier_flag(*modifier),
                params,
            )?;
        }
        crate::computer::ensure_input_generation(generation)?;
        post_key(&source, code, true, flags, params)?;
        crate::computer::ensure_input_generation(generation)?;
        post_key(&source, code, false, flags, params)?;
        for modifier in parsed.modifiers.iter().rev() {
            crate::computer::ensure_input_generation(generation)?;
            post_key(
                &source,
                modifier_code(*modifier),
                false,
                CGEventFlags::empty(),
                params,
            )?;
        }
        Ok(serde_json::json!({}))
    }

    pub(super) fn scroll(params: &Value) -> Result<Value, HostError> {
        let generation = crate::computer::input_generation()?;
        let x = params
            .get("x")
            .and_then(Value::as_f64)
            .ok_or_else(|| HostError::InvalidParams("x is required".to_string()))?;
        let y = params
            .get("y")
            .and_then(Value::as_f64)
            .ok_or_else(|| HostError::InvalidParams("y is required".to_string()))?;
        let dx = params.get("dx").and_then(Value::as_i64).unwrap_or(0) as i32;
        let dy = params.get("dy").and_then(Value::as_i64).unwrap_or(5) as i32;
        let source = source()?;
        let move_event = CGEvent::new_mouse_event(
            source.clone(),
            CGEventType::MouseMoved,
            CGPoint::new(x, y),
            CGMouseButton::Left,
        )
        .map_err(|_| HostError::Native("could not create mouse event".to_string()))?;
        crate::computer::ensure_input_generation(generation)?;
        post_checked(&move_event, Some(CGPoint::new(x, y)), None)?;
        let event = CGEvent::new_scroll_event(source, ScrollEventUnit::LINE, 2, -dy, -dx, 0)
            .map_err(|_| HostError::Native("could not create scroll event".to_string()))?;
        crate::computer::ensure_input_generation(generation)?;
        post_checked(&event, Some(CGPoint::new(x, y)), None)?;
        Ok(serde_json::json!({}))
    }
}

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::HostError;
    use serde_json::Value;

    pub(super) fn click(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
    pub(super) fn move_pointer(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
    pub(super) fn type_text(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
    pub(super) fn key(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
    pub(super) fn scroll(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn protected_regions() -> Result<Value, HostError> {
    Ok(serde_json::json!(macos::protected_regions()?
        .into_iter()
        .map(|(x, y, width, height)| {
            serde_json::json!({ "x": x, "y": y, "width": width, "height": height })
        })
        .collect::<Vec<_>>()))
}

pub fn click(params: &Value) -> Result<Value, HostError> {
    macos::click(params)
}

pub fn install_consent_guard() {
    #[cfg(target_os = "macos")]
    macos::install_consent_guard();
}
pub fn move_pointer(params: &Value) -> Result<Value, HostError> {
    macos::move_pointer(params)
}
pub fn type_text(params: &Value) -> Result<Value, HostError> {
    macos::type_text(params)
}
pub fn key(params: &Value) -> Result<Value, HostError> {
    macos::key(params)
}
pub fn scroll(params: &Value) -> Result<Value, HostError> {
    macos::scroll(params)
}

#[cfg(test)]
mod tests {
    use super::{parse_key_combo, Modifier};
    use crate::computer::{ensure_input_generation, key_generation, kill, KILLED};
    use std::sync::atomic::Ordering;

    #[test]
    fn blocks_consent_apps_and_background_window_regions() {
        assert!(super::is_synthetic_input(super::SYNTHETIC_INPUT_MARKER));
        assert!(!super::is_synthetic_input(0));
        assert!(super::protected_application(
            42,
            "ai.touri.desktop",
            "touri"
        ));
        assert!(super::protected_application(
            std::process::id() as i32,
            "dev.bundle",
            "dev"
        ));
        assert!(super::protected_application(
            42,
            "com.apple.systempreferences",
            "Settings"
        ));
        assert!(!super::protected_application(
            42,
            "com.apple.Safari",
            "Safari"
        ));
        assert!(super::contains_point(
            (-100.0, 40.0, 400.0, 200.0),
            (-50.0, 100.0)
        ));
        assert!(!super::contains_point(
            (-100.0, 40.0, 400.0, 200.0),
            (350.0, 100.0)
        ));
        assert!(super::terminal_application(
            "com.apple.Terminal",
            "Terminal"
        ));
        assert!(super::terminal_application(
            "com.mitchellh.ghostty",
            "Ghostty"
        ));
    }

    #[test]
    fn parses_cmd_shift_four() {
        let parsed = parse_key_combo("cmd+shift+4").expect("valid key combo");
        assert_eq!(parsed.modifiers, vec![Modifier::Cmd, Modifier::Shift]);
        assert_eq!(parsed.key, "4");
    }

    #[test]
    fn rejects_unknown_modifiers() {
        assert!(parse_key_combo("meta+4").is_err());
    }

    #[test]
    fn native_input_generation_rejects_events_after_kill() {
        let _guard = crate::computer::test_lock().lock().expect("test lock");
        KILLED.store(false, Ordering::SeqCst);
        let generation = key_generation();
        kill();
        assert!(ensure_input_generation(generation).is_err());
        KILLED.store(false, Ordering::SeqCst);
    }
}
