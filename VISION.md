# touri vision

touri is the place on your Mac where your AI teammates live and work. Each bot has a name, a job,
a memory and its own corner of your machine. You hire it once, it keeps working, and you can always
see what it did and stop it.

This file is the yardstick for every issue and pull request. If a change does not move touri toward
what is written here, it waits. If it moves touri away from it, it does not ship.

## Who it is for

One person, or a very small team, who already pays for Codex, Claude Code or OpenCode and wants
those agents to work for them every day: write code in their repos, run routines, browse the web,
and report back. They want more done, not another dashboard to babysit.

## What touri promises

1. **Your machine, your data.** Conversations, memory, routines and secrets live on the Mac.
   No touri account, no telemetry, no server between the user and their agents. Anything remote is
   opt-in and says so on screen.
2. **Your own agents, your own keys.** touri runs the CLIs the user already has, signed in with the
   user's own account. touri never reads, stores or proxies model credentials, and never resells
   model access.
3. **Nothing is lost.** Every message, failed turn, canceled run and tool result stays in history.
   Native sessions resume. The user's words always reach the next turn.
4. **The user is in charge.** Risky actions ask first. Approvals are explicit clicks, never a stray
   keystroke. Computer use and browser control are opt-in, visible while active, and have a kill
   switch. A bot can always hand a task back to the human ("take over") instead of guessing.
5. **It works on the real web.** A bot that cannot open the site it was asked to use is broken,
   not "blocked". touri solves this honestly: by letting the bot use a browser the user really owns
   (their own Chrome, profile and network, when they choose it), by asking the human to clear a
   challenge, and by saying clearly when a site refuses automation. touri does not ship fingerprint
   spoofing or captcha solving in the default path.
6. **Isolation when you want it.** A bot can run on the Mac or in its own Linux machine. The user
   picks per bot, and the UI always shows where a bot runs and what it can reach.
7. **Calm, clear, native.** A Mac app that feels like one: fast, quiet, readable in light and dark,
   accessible, in the user's language. Errors say what happened and what to do next, in plain words,
   never a raw stack trace or an internal tool name.

## Non-goals

- A general-purpose browser, IDE or chat client for the human.
- Hosting, multi-tenant SaaS, or syncing between machines (the optional cloud protocol is separate).
- Selling, proxying or metering model access.
- Copying code from other agent projects. Everything here is original or properly licensed.
- Features that only work for the maintainers' own setup.

## How an issue is judged

An issue is ready to work on when it answers yes to all of these:

1. **Promise.** Which promise above does it strengthen? (Name the number.) A change that weakens one
   needs an explicit, written trade-off in the issue.
2. **User.** Is there a concrete moment where a real user hits this today? Describe it in one or two
   sentences.
3. **Local-first.** Does it work with no network service other than the user's CLIs, git remotes
   and the sites the bot visits?
4. **Control.** If it lets a bot do more, is the new power opt-in, visible and stoppable?
5. **Evidence.** Can the fix be shown: a test, a screenshot or a short recording of the real app?

An issue that fails one of these is labeled `question` and gets a comment that names the failing
check, instead of being implemented.

## How a change is judged

- It does one thing, with tests next to it, and passes the checks in `README.md` ("Verify").
- Contract changes in `packages/contracts/` land before the work that depends on them.
- User-facing text is clear, in Portuguese and English where the UI already has both.
- No secret, personal path, email or internal hostname appears in code, logs, fixtures or docs.
- The pull request shows evidence from the running app for anything a user can see.
