# Slack app setup

Dispatch needs a Slack bot user that can (a) read recent messages from the announcements + team channels as ingestion sources and (b) post "Draft ready" notifications + operational alerts to the newsletter-review channel. This doc walks through provisioning the app once per environment.

> Different Slack workspace per environment. Staging and production should not share a bot. The review channel, channels the bot reads from, and HR-bot user IDs are all env-scoped fields on `dispatch/{env}/slack` and `dispatch/{env}/runtime-config`.

## 1. Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Name it `dispatch-staging` (or `dispatch-production`). Pick the target workspace.
3. Basic Information → record the **Signing Secret** (unused for inbound traffic today — Dispatch does not receive Slack events — but keep it in case you later add a slash command).

## 2. Bot token scopes

**OAuth & Permissions → Bot Token Scopes**. Add exactly these:

| Scope | Why |
|---|---|
| `channels:history` | Read recent messages in the announcements + team channels (Slack aggregator). |
| `channels:read` | Look up channel IDs and validate the bot's membership. |
| `chat:write` | Post "Draft ready" + "Pipeline alert" messages to the review channel. |
| `users:read` | Resolve `user_id` → display name when sanitizing Slack author attribution. |

That's it — no write access beyond `chat:write`, no admin scopes, no private-channel scopes. Dispatch never reads DMs or private channels.

Click **Install to Workspace** at the top of the same page. Record the **Bot User OAuth Token** (`xoxb-…`) — it goes into `dispatch/{env}/slack` as `botToken`.

## 3. Identify the channel IDs

Three channels matter. In Slack, right-click each → **View channel details** → copy the channel ID at the bottom (starts with `C`):

| Channel | What it is | Goes into |
|---|---|---|
| `#announcements` (or your team's equivalent) | Company-wide announcements, wins, recognitions. The aggregator reads the last 7 days; items ≥20 chars (`MIN_ANNOUNCEMENT_LENGTH`) and ≤2000 chars (`MAX_TOKEN_LENGTH`) pass through. | `dispatch/{env}/slack.announcementsChannelId` |
| `#team` (or your cross-team updates channel) | Weekly team updates, standup summaries, shout-outs. Same filters. | `dispatch/{env}/slack.teamChannelId` |
| `#newsletter-review` | Where Dispatch posts "Draft ready" and pipeline alerts. The Chief of Staff + backup approvers should be members. | `dispatch/{env}/runtime-config.slackReviewChannelId` |

## 4. Invite the bot to each channel

The bot can only read + post in channels it's a member of. From each channel:

```
/invite @dispatch-staging   # or @dispatch-production
```

If the aggregator logs `slack.history-failed: not_in_channel` or `channel_not_found`, this is the fix.

## 5. HR-bot filtering (optional)

If your Slack workspace has an HRIS integration posting updates to the announcements channel (birthdays, work-anniversaries, new-hire pings), you usually want those filtered out of the newsletter — they're already covered by the `new_joiners` section via WorkOS Directory.

1. In the announcements channel, click one of the HR-bot messages → **More actions** → **View message source** (or inspect via `chat.postMessage` API response if you have access).
2. Record the `user_id` of the bot (starts with `U` or `B` for classic app bots).
3. Add the IDs to `dispatch/{env}/slack.hrBotUserIds`:

```bash
aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id dispatch/staging/slack \
  --secret-string "$(jq '.hrBotUserIds = ["U0HRBOT0001","U0HRBOT0002"]' < slack-staging.json)"
```

The Slack aggregator filters messages whose `user` matches any entry in this list. Missing or empty list means no filtering.

## 6. Verify

From your laptop (or a bastion with AWS creds + Slack SDK):

```bash
BOT_TOKEN=$(aws secretsmanager get-secret-value \
  --region us-west-2 --secret-id dispatch/staging/slack \
  --query SecretString --output text | jq -r .botToken)

# Token still valid?
curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
  https://slack.com/api/auth.test | jq

# Bot is a member of the review channel?
REVIEW_CHANNEL=$(aws secretsmanager get-secret-value \
  --region us-west-2 --secret-id dispatch/staging/runtime-config \
  --query SecretString --output text | jq -r .slackReviewChannelId)

curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
  "https://slack.com/api/conversations.members?channel=${REVIEW_CHANNEL}" | jq
```

`auth.test` should return `{ "ok": true, "user": "dispatch-staging", ... }`. `conversations.members` should include your bot's user ID (visible as `auth.test.user_id`).

## Rotating the bot token

When the token rotates (personnel change, 90-day cadence, or a leak):

1. In the Slack app page → **Install App** → **Reinstall to Workspace**. This issues a new `xoxb-…`.
2. Update the secret + force the tasks to roll:

```bash
aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id dispatch/staging/slack \
  --secret-string "$(jq '.botToken = "xoxb-NEW..."' < slack-staging.json)"

aws ecs update-service --region us-west-2 \
  --cluster <cluster> --service <api-service> --force-new-deployment
aws ecs update-service --region us-west-2 \
  --cluster <cluster> --service <web-service> --force-new-deployment
# Pipeline picks up new secrets on the next scheduled run.
```

3. If the bot is still a member of all three channels in the Slack UI, nothing else is needed. If the reinstall dropped memberships, re-run the `/invite` commands from step 4.

## What Dispatch does NOT do with Slack

Worth calling out explicitly so you can audit the scope if security asks:

- **No slash commands.** Dispatch posts notifications and reads channel history; it never handles inbound Slack events. No request-URL endpoint, no Socket Mode connection.
- **No DMs.** The bot never messages users directly. "Draft ready" goes to the review channel; operational alerts go to the review channel; the bot does not `chat.postMessage` to user IMs.
- **No file uploads.** Newsletters are sent via SES, not Slack.
- **No private-channel access.** `groups:*` scopes are not requested.
- **No `chat:write.public`.** The bot must be explicitly invited to any channel it posts to.

If a future iteration adds a `/dispatch` slash command for operators (e.g. triggering a manual run), that's a new scope + a new Slack event ingress — document it in this file when it lands.
