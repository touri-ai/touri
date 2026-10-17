#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeepLink {
    pub bot: Option<String>,
    pub thread: Option<String>,
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

/// Parses `touri://open?bot=<id>&thread=<id>`. Any other scheme, host or empty selection is rejected.
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
    };
    (link.bot.is_some() || link.thread.is_some()).then_some(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bot_and_thread() {
        assert_eq!(
            parse("touri://open?bot=bot-1&thread=th%202"),
            Some(DeepLink {
                bot: Some("bot-1".into()),
                thread: Some("th 2".into())
            })
        );
    }

    #[test]
    fn accepts_a_single_selector() {
        assert_eq!(
            parse("touri://open?thread=abc"),
            Some(DeepLink {
                bot: None,
                thread: Some("abc".into())
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
}
