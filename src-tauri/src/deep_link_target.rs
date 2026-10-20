#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeepLink {
    pub bot: Option<String>,
    pub thread: Option<String>,
    pub notification_id: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDeepLink {
    pub request_id: u64,
    pub target: DeepLink,
}

/// A cold-start click survives until the main webview applies its navigation.
#[derive(Default)]
pub struct PendingDeepLinks {
    next_request_id: u64,
    pending: Option<PendingDeepLink>,
}

impl PendingDeepLinks {
    pub fn publish(&mut self, target: DeepLink) -> PendingDeepLink {
        self.next_request_id = self.next_request_id.saturating_add(1);
        let pending = PendingDeepLink {
            request_id: self.next_request_id,
            target,
        };
        self.pending = Some(pending.clone());
        pending
    }

    pub fn pending(&self) -> Option<PendingDeepLink> {
        self.pending.clone()
    }

    pub fn acknowledge(&mut self, request_id: u64) {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.request_id == request_id)
        {
            self.pending = None;
        }
    }
}

/// Navigation belongs to the notification the OS reports as clicked. Focus and dismissal do nothing.
pub fn notification_target(action: &str, url: Option<&str>) -> Option<DeepLink> {
    if action != "tap" {
        return None;
    }
    url.and_then(parse)
}

fn decode(value: &str) -> String {
    let bytes = value.replace('+', " ").into_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = bytes
            .get(index + 1..index + 3)
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[index], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                index += 3;
            }
            (other, _) => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses a touri open link and rejects unrecognized hosts or links without a selected target.
pub fn parse(url: &str) -> Option<DeepLink> {
    let rest = url.strip_prefix("touri://")?;
    let (host, query) = rest.split_once('?').unwrap_or((rest, ""));
    if host.trim_end_matches('/') != "open" {
        return None;
    }
    let find = |key: &str| {
        query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(name, _)| *name == key)
            .map(|(_, value)| decode(value))
            .filter(|value| !value.is_empty())
    };
    let link = DeepLink {
        bot: find("bot"),
        thread: find("thread"),
        notification_id: find("notification")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991),
    };
    (link.bot.is_some() || link.thread.is_some() || link.notification_id.is_some()).then_some(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_start_target_survives_reads_and_only_its_own_acknowledgement() {
        let mut inbox = PendingDeepLinks::default();
        let target = parse("touri://open?bot=bot-1&thread=thread-1").unwrap();
        let first = inbox.publish(target.clone());
        assert_eq!(inbox.pending(), Some(first.clone()));
        assert_eq!(inbox.pending(), Some(first.clone()));
        let second = inbox.publish(target);
        assert!(second.request_id > first.request_id);
        inbox.acknowledge(first.request_id);
        assert_eq!(inbox.pending(), Some(second.clone()));
        inbox.acknowledge(second.request_id);
        assert_eq!(inbox.pending(), None);
    }

    #[test]
    fn parses_bot_and_thread() {
        assert_eq!(
            parse("touri://open?bot=bot-1&thread=th%202"),
            Some(DeepLink {
                bot: Some("bot-1".into()),
                thread: Some("th 2".into()),
                notification_id: None,
            })
        );
    }

    #[test]
    fn accepts_a_single_selector() {
        assert_eq!(
            parse("touri://open?thread=abc"),
            Some(DeepLink {
                bot: None,
                thread: Some("abc".into()),
                notification_id: None,
            })
        );
    }

    #[test]
    fn rejects_other_schemes_hosts_and_empty_queries() {
        assert_eq!(parse("https://open?bot=a"), None);
        assert_eq!(parse("touri://settings?bot=a"), None);
        assert_eq!(parse("touri://open"), None);
        assert_eq!(parse("touri://open?bot="), None);
    }

    #[test]
    fn clicks_use_the_clicked_payload_without_a_latest_target_or_time_limit() {
        let first = "touri://open?bot=a&thread=thread-a";
        let second = "touri://open?bot=b&thread=thread-b";
        assert_eq!(
            notification_target("tap", Some(second))
                .unwrap()
                .bot
                .as_deref(),
            Some("b")
        );
        assert_eq!(
            notification_target("tap", Some(first))
                .unwrap()
                .thread
                .as_deref(),
            Some("thread-a")
        );
        assert_eq!(notification_target("dismiss", Some(first)), None);
        assert_eq!(notification_target("focus", Some(second)), None);
        assert_eq!(notification_target("tap", None), None);
    }

    #[test]
    fn notification_click_keeps_the_exact_card_id() {
        let target =
            notification_target("tap", Some("touri://open?bot=b&thread=t&notification=42"))
                .expect("notification target");

        assert_eq!(target.notification_id, Some(42));
        assert_eq!(
            notification_target("tap", Some("touri://open?notification=0")),
            None
        );
        assert_eq!(
            notification_target("tap", Some("touri://open?notification=bad")),
            None
        );
    }
}
