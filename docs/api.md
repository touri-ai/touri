# Work integration messages

`POST /api/v1/threads/:id/messages` (also `/api/threads/:id/messages`) accepts an
explicit integration sender for a Work channel:

```sh
curl "$TOURI_URL/api/v1/threads/$CHANNEL_THREAD_ID/messages" \
  -H "Authorization: Bearer $TOURI_TOKEN" \
  -H 'X-Touri-Client: touri avisos' \
  -H 'Content-Type: application/json' \
  --data '{"text":"Publicação concluída","parentId":null,"attachmentIds":[],"clientNonce":"publish-42","as":{"kind":"integration"}}'
```

The server grants `integration:write` only to an active administrator's device
bearer token. Member tokens, browser cookies, expired/revoked tokens and
unauthenticated requests cannot use this capability. The header supplies a name,
never authorization. Pair and rotate tokens through the existing device flow;
keep the token in the caller's secret store and use HTTPS remotely.

`as.name` optionally overrides `X-Touri-Client`. Names contain 1–80 letters,
numbers, spaces, dots, underscores or hyphens. Names matching a channel person,
handle, bot or owner aliases are rejected, including accent/case variants.
Only `kind` and `name` are accepted in `as`; callers cannot choose an identity ID,
person, bot, role or avatar. IDs and avatars are derived from the authenticated
device and normalized name. Token rotation preserves the device's identity.
Omit `as` to retain ordinary authenticated-person behavior.

Integration messages return `message.sender.kind: "integration"`, a distinct ID,
display name and avatar seed. The UI marks them as an integration and incoming
message. History and unread counts persist. Each channel person receives one
`notice`, or one `mention` if explicitly named, through existing notification
preferences and quiet hours. Native alerts remain silent while focused.
Integration posts never answer pending human questions or approvals.

Bots receive work only through explicit `@BotName` mentions. Person mentions such
as `@pessoa` do not dispatch bots. `groupAction` is rejected for integration sends;
direct conversations and internal bot participant threads are also rejected.

Use a stable `clientNonce` per delivery. Repeating the same sender/content returns
the existing message without another unread increment or notification; changing
sender or content under the same nonce returns `409 NONCE_CONFLICT`. An ordinary
channel notice returns `201` with `run: null` (`200` on replay).

Invalid identities return `400 INVALID_INTEGRATION`; missing integration scope
returns `403 FORBIDDEN`; authentication failures return `401 UNAUTHORIZED`.
