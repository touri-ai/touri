# QA round 4 recovery evidence

Deterministic browser tests render the actual app with local fixtures. VM frames are mocked: transparent until the guest paints, opaque black for an empty desktop, then a visible window. These tests establish UI readiness and consent behavior; they do not certify a live VM's input transport.

- Drafts persist through a fresh browser context and clear after successful sending: [restored draft](draft-restored.png).
- Disabled browser and automated control are explained with contextual settings actions: [disabled capabilities](browser-disabled.png), [browser setting before consent](browser-consent.png).
- Human ownership without a frame does not announce usable control: [waiting for the image](takeover-awaiting-frame.png).
- After reconnecting, the viewer returns to observation: [reconnected screen](reconnected-observation.png).
- A newer successful reply leaves the earlier failure in resolved bell history: [resolved attention](attention-resolved.png).

Run `bun --cwd ui test:e2e test/e2e/qa-r4.spec.ts --workers=1`. The test suite starts a local development server when no `PLAYWRIGHT_BASE_URL` is supplied and creates these screenshots. Draft unit tests also cover the desktop bridge, multiple conversations, rejected sends, storage failure and sending after navigation. Notification backend tests verify durable resolution and startup reconciliation, including group member conversations.

VISION promises: 1, 3, 4, 5, 6 and 7. Issues: #164, #165 and #166.
