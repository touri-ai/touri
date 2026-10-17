#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    Granted,
    Denied,
    NotDetermined,
    Unknown,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::NotDetermined => "not-determined",
            Self::Unknown => "unknown",
        }
    }
}

/// UNAuthorizationStatus and UNNotificationSetting values reported by the OS.
/// A badge alone does not establish delivery of a visible notification.
pub fn from_settings(authorization: isize, alerts: isize, center: isize) -> Permission {
    match authorization {
        0 => Permission::NotDetermined,
        1 => Permission::Denied,
        2 | 3 if alerts == 2 || center == 2 => Permission::Granted,
        2 | 3 => Permission::Denied,
        _ => Permission::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_denied_or_undecided_os_never_reports_active_delivery() {
        assert_eq!(from_settings(1, 2, 2), Permission::Denied);
        assert_eq!(from_settings(0, 2, 2), Permission::NotDetermined);
    }

    #[test]
    fn authorization_with_visible_delivery_disabled_is_blocked() {
        assert_eq!(from_settings(2, 1, 1), Permission::Denied);
        assert_eq!(from_settings(3, 1, 1), Permission::Denied);
        assert_eq!(from_settings(2, 2, 1), Permission::Granted);
        assert_eq!(from_settings(3, 1, 2), Permission::Granted);
    }

    #[test]
    fn unrecognized_os_states_are_not_assumed_granted() {
        assert_eq!(from_settings(99, 2, 2), Permission::Unknown);
        assert_eq!(Permission::Unknown.as_str(), "unknown");
    }
}
