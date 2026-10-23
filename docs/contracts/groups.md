# Group creation and validation

`POST /groups` accepts `GroupCreateInput`. The `name`, `color`, `memberIds` and
`coordinatorBotId` fields are required. Omitting `avatarShape` selects `classic-none`;
explicit null or invalid shapes are rejected. The saved group always has a shape.
Existing valid shapes, including supported legacy shapes, remain accepted.

`PATCH /groups/:id` still requires the complete `GroupInput`, including `avatarShape`.
Omitting it does not reset an existing avatar. No database migration is required:
the stored group schema is unchanged.

Invalid input returns HTTP 400, `errorCode: INVALID_ARGS`, `code: TOURI-E1001`,
and a fixed `field` identifying the first invalid field. The default `error` is
Portuguese. `errorMessages` contains the same Portuguese text under `pt-BR` and an
English translation under `en`. For example:

```json
{
  "errorCode": "INVALID_ARGS",
  "code": "TOURI-E1001",
  "origin": "validation",
  "domain": "kernel",
  "retryable": false,
  "field": "avatarShape",
  "error": "avatarShape: informe um formato de mascote válido, como classic-none.",
  "errorMessages": {
    "pt-BR": "avatarShape: informe um formato de mascote válido, como classic-none.",
    "en": "avatarShape: enter a valid avatar shape, such as classic-none."
  }
}
```

Allowed fields are `body`, `name`, `color`, `avatarShape`, `memberIds`,
`coordinatorBotId`, and `title` (for group conversation creation). Error normalization
rebuilds these messages from a fixed allowlist. Submitted values, exception text and
unknown fields are never copied into the response. Authentication and group access
rules are unchanged.
