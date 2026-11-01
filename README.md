# Friday 🤖

A personal AI assistant that lives in WhatsApp, powered by Claude. Message it like a friend — privately or in a group —
and it can:

- 💬 **Answer questions** and help with writing, planning, translating, maths… in any language
- 🌐 **Search the web** for current info (news, weather, prices, opening hours) and read links you send
- ⏰ **Set reminders** — one-off ("at 5pm") or repeating ("every weekday at 8"), for you or someone else
- 📄 **Make documents** and send them as files: PDF, Word, Excel, CSV, PowerPoint
- 🎨 **Create and edit pictures** — "draw a birthday card", or send a photo and say "make the background a beach"
- 👀 **Read photos, PDFs and text files** you send, and **understand voice notes** (transcribed for free with Cloudflare;
  Friday answers in text)
- 🧠 **Remember things** you tell it (birthdays, preferences) across conversations
- 📨 **Pass messages** to other people ("tell Sarah I'll be late")
- 📈 **Analyse markets** — stocks, forex, gold and crypto on any timeframe, with a chart, a trading plan and how often
  that plan paid in the past

## How it works

Friday runs on your computer (or a server) and connects to WhatsApp as a **linked device** on a spare number, the same
way WhatsApp Web does. Messages go to Claude (Opus 5.5 by default), which can use the tools above. Everything Friday
stores — conversations, reminders, memories, images — stays in the local `data/` folder.

> Friday uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp library. That's what makes
> it free and flexible, but WhatsApp could ban a number it considers a bot. Use a **spare number**, and don't use
> Friday to message people who haven't messaged it first.

## Setup

**You need:** Node.js 22+, a spare WhatsApp number (a second SIM, or the WhatsApp Business app on any phone),
a [Claude API key](https://console.anthropic.com/settings/keys), and — for pictures — a free Cloudflare account.

```bash
git clone git@github.com:albird97/friday.git
cd friday
npm install
cp .env.example .env
```

Open `.env` and fill in:

| Setting | What to put |
|---|---|
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `ALLOWED_CONTACTS` | Who can use Friday: `Albert=6281234567890,Sarah=6289876543210` (country code, no `+`). **The first person is the admin.** |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | For pictures (free). In the [Cloudflare dashboard](https://dash.cloudflare.com) open **AI → Workers AI → Use REST API**: copy the Account ID and click **Create a Workers AI API Token**. |

### Try it in the terminal first

```bash
npm run chat
```

Chat with Friday right in the terminal — same brain, tools and memory, no phone needed. Files and pictures it makes
are saved to `data/outbox/`. Attach a file with `/attach path/to/photo.jpg what's in this?`.

### Connect WhatsApp

```bash
npm start
```

A QR code appears. On the **spare** phone open WhatsApp → **Settings → Linked devices → Link a device** and scan it.
(Can't scan? Set `PAIRING_NUMBER` to the bot's number in `.env` and you'll get an 8-character code to type in instead.)
You'll see `✅ Connected`. Now message the spare number from your own phone.

The login is saved in `data/whatsapp-auth/`, so you only scan once.

### Keep it running

Friday only works (and only sends reminders) while it's running.

- **On your Mac, always on:** `scripts/macos-service.sh install` runs Friday in the background — it starts at login,
  restarts if it stops, and keeps the Mac from idle-sleeping. Use `scripts/macos-service.sh logs` to watch it (and to
  see the QR code the first time), `restart` after changing `.env`, `uninstall` to remove it.
- **On your Mac, just for now:** `caffeinate -i npm start` in a terminal; Friday stops when you close it.
- **On a Linux server that also runs other apps:** `sudo scripts/linux-service.sh install` sets Friday up under
  `/opt/friday` as a systemd service with its own Node, a 400 MB memory cap and the lowest CPU priority, so it never
  slows the other apps down. It also backs up the database, the WhatsApp login and `.env` every night at 03:30
  (14 days in `/opt/friday/backups`; `backup` runs one now — restore steps are in `scripts/backup.sh`). Put your `.env` in `/opt/friday/app/` (to move from another machine, also copy its
  `data/` folder there and stop the old copy first), then `restart`. `update` pulls new code; `logs` follows the log.
- **On a server with Docker:** `docker compose up -d`, then `docker compose logs -f` to see the QR code the
  first time. Data is kept in `./data`.

## Using Friday

**Private chat:** just message it.

**Groups:** add the bot's number to a group. Friday stays quiet unless someone **@mentions** it, **replies** to one of
its messages, or starts a message with **"Friday,"** (or "hey Friday"). Anyone in the group can talk to it this way
(set `GROUP_ACCESS=contacts` to limit it to your contacts).

Things to try:

- "Remind me to pay the electricity bill on the 25th at 9am, every month"
- "What's the weather in Bandung this weekend?"
- "Make a PDF itinerary for our 3-day Bali trip"
- "Put our monthly budget in an Excel sheet: rent 5jt, food 3jt, …"
- "Draw a cute birthday card for a 6-year-old who loves dinosaurs"
- *(send a photo)* "Remove the people in the background"
- *(reply to a photo in a group)* "@Friday what plant is this?"
- "Remember that Sarah is allergic to peanuts"
- "Tell Sarah I'll be home at 8"
- *(in a group)* "@Friday see who can come to dinner on Saturday at 7" — sends a poll; later "@Friday who's coming?"
- *(admin only)* "Post in the Kongkow group: we meet at 7" — Friday posts it as itself
- "Analisis BBCA harian dan buatkan trading plan", then "kenapa SL-nya di situ?"

### Commands

| Command | |
|---|---|
| `/help` | What Friday can do |
| `/reset` | Start a fresh conversation (memories and reminders are kept) |
| `/id` | Show this chat's id and your number |
| `/usage` | *(admin)* Claude usage per person, today and this month: estimated dollars (list prices) and tokens |
| `/contacts` | *(admin)* Who can use Friday |
| `/add <name> <number>` | *(admin)* Let someone use Friday and send them a welcome message listing what it can do, e.g. `/add Mom 6281234567890` |
| `/remove <name>` | *(admin)* Remove someone added with `/add` |
| `/katalog` | *(admin)* Put the features in `catalog/items.json` into Friday's WhatsApp Business catalog (adds new items, updates changed ones; WhatsApp reviews each) |

Not listed in `/help` (admin only; answers always go to the admin's private chat, so nothing shows in a group):

| Command | |
|---|---|
| `/status` | Uptime, running version, model, memory and database size, active reminders, today's and this month's estimated cost (also in rupiah, `USD_TO_IDR`), and what is paused |
| `/diam [30m \| 2j \| 1h]` | In a group: Friday ignores that group for a while (default 1 hour, at most 7 days; `h` = hari, days) |
| `/bangun` | In a group: end its `/diam` early |
| `/switch [opus \| sonnet \| haiku]` | Change the Claude model for every chat, private and group, admin or not. Always the family's newest version: Friday looks it up now and daily, and tells the admin when it moves up. Each chat continues from a short recap. `/switch` alone shows the current model |
| `/stop` | Emergency stop: Friday ignores every chat (errand replies included) until `/lanjut`. Reminders still go out |
| `/lanjut` | Undo `/stop` |
| `/style [chill \| formal \| funny \| ngeyel \| normal]` | How Friday talks in this chat (group or private). `ngeyel` is devil's advocate: it argues against whatever is said, but still does tasks properly, never invents facts, answers in one voice (no separate "serious" part) and on health, safety, legal and money always argues for the careful side. Takes effect from the next message; `/style` alone shows the current one |
| `/backup` | Send the admin a copy of Friday's database (contacts, memories, reminders, polls, conversations, usage; not the WhatsApp login) |

## Errands with people outside the contacts

People listed in `ERRAND_USERS` can ask Friday, in their private chat, to deal with someone who isn't a contact —
"book a table for 4 at Sate Senayan on Saturday at 7", "ask this shop if they have size 42":

1. If they don't give a number, Friday looks it up (Google Maps listing, website, Instagram bio, Linktree…), checks
   that it's on WhatsApp, and shows it with its source and the first message. Nothing is sent until they reply
   `YA 1234`.
2. Friday then answers the other side by itself **in their name**, written as them in the first person, within the
   brief: it shares only the details given, and anything else — a deposit, another time, a price — comes back as a
   "❓" question first. It doesn't volunteer that it's an assistant, but if the other side sincerely asks whether
   they're talking to a bot or AI, it doesn't lie: it says it's the person's assistant arranging this for them.
3. Every message both ways is mirrored to their chat, and the outcome arrives as a "📋" summary.

Each errand runs in its own conversation that can only reply to that one number, ask, or finish — it has no web,
files, memories or onehub. Strangers who weren't contacted through an errand are still ignored. Messaging people who
haven't written first is what gets bot numbers flagged by WhatsApp, so keep it to real errands; `ERRAND_DAILY_LIMIT`
(10 by default) caps new ones per day.

## Business back office (onehub)

Friday can also work with onehub, the business's back-office system, for the people listed in `ONEHUB_USERS` — and
only in their private chats (never in groups, where others read along).

- **Looking things up** ("sales today?", "stock of ABC-12", "unshipped orders as Excel"): Friday writes SQL against
  onehub's database through a PostgreSQL role that can only `SELECT`, and never sees tables or columns that role isn't
  granted (credentials, payroll…). Queries are limited to one statement, 8 seconds and 200 rows.
- **Doing things** (e.g. correcting stock): onehub's internal API lists the actions it allows. When Friday proposes
  one, onehub computes a preview and Friday's code — not Claude — sends it with a one-time code. The action runs only
  when that person replies `YA 1234` within 10 minutes; the confirmation never goes through Claude.

## Sharing with family and friends

Add people with `/add` (or in `ALLOWED_CONTACTS`). `/add` also greets them on WhatsApp, in Indonesian, with what they can use and an example of each. Only the admin sees who else uses Friday: admin commands always answer in the admin's
private chat (even when sent in a group), and nobody else's conversations include the contact list. Each person gets their own private conversation, reminders and
memories — others can't see them (though as the host, the data lives on your machine). To protect your bill, everyone
except the admin is limited to `DAILY_MESSAGE_LIMIT` messages a day (50 by default). People who aren't contacts are
ignored in private chats; Friday logs their number so you can `/add` them.

The website's "Minta akses" button opens WhatsApp with a sentence already typed. Friday answers that sentence once per
number with a fixed text (no Claude, no cost) and tells the admin, who decides with `/add`.
`ACCESS_REQUEST_DAILY_LIMIT` (20 by default) caps how many it answers per day.

## Google apps

Each contact links their own Google account by sending `/google` in their private chat, and `/google putus` ends it.
YouTube is a second step, `/google youtube`, because Google won't ask for it on the same screen as Drive files.
Friday then works with that person's Calendar, Tasks, Gmail, Drive, Docs, Sheets, Slides, Forms, Contacts and YouTube,
only in their private chat. The account is found from the sender's number, so nobody can reach someone else's. Reading
runs straight away. Anything that changes something gets a preview and needs a `YA 1234` reply, checked by code rather
than by Claude. Tokens are encrypted with `GOOGLE_TOKEN_KEY`.

On the server, after pointing the domain's DNS at it and creating a Web OAuth client in the Google Cloud project:

```bash
sudo /opt/friday/app/scripts/linux-service.sh web fridayai.my.id
sudo /opt/friday/app/scripts/linux-service.sh google fridayai.my.id
```

## Market analysis

Any contact can ask for technical analysis of Indonesian and US stocks, forex, gold, crypto, or anything Yahoo Finance
lists, on any timeframe from 1 minute to months. Friday sends a chart with the analysis drawn on it (levels, swings,
trend, a price range, entry, stop and targets) and explains it. Follow-up questions work in the same chat.

- **Numbers come from code, not from Claude.** `src/market/` fetches real closed candles, computes everything, and
  Claude only explains the result. Candles are free and need no key: Yahoo for stocks, forex and daily gold, Binance for
  crypto and intraday gold. Yahoo's feed is unofficial, so it can stop working or limit the server for a while. Crypto and
  intraday gold keep working if it does.
- **It doesn't predict direction.** Tested on 32 instruments after costs, classic technical rules didn't beat random
  entries on any timeframe, and shorter timeframes lost more. What did hold was the price range: its 80% band was right
  78-80% of the time. So Friday never promises accuracy.
- **Chance of profit is measured, not estimated.** Each plan shows how often the same setup on the same instrument and
  timeframe reached each target and ended in profit, after costs, with the number of past cases, next to what random
  entries did. The replay uses the plan's exact levels, and a gap past the entry costs what it would really cost. These
  figures hold up: on daily candles, plans printed a 38.5% chance of profit at TP2 and 38.1% of those 11,267 trades got
  there. That says how often a plan pays, not that it pays: the average was still slightly negative.
- **Ready is rare and unproven.** A plan is only called ready on daily candles or longer, when its history beats random
  entries by more than chance. Walked forward over 32 instruments that was about 1 signal in 20, at +0.26R ±0.28 per
  trade: encouraging, not proof. Below daily candles the signals lost money after costs, so no edge is claimed there.
- **Waiting scenarios aren't recommendations.** Most of the time Friday says to wait and gives two stop-order scenarios
  so people have a plan either way. On their own those breakouts lost money on average after costs (-0.05R on daily
  candles), which Friday shows rather than hides.
- **Indonesian stocks** use IDX price steps and lots, and a falling stock reads "avoid", because retail traders can't
  short them.

It is off the website and the catalog (`pending` in `feature-map.json`) until the OJK rules on recommending securities
are checked: POJK 6/2026 requires an investment adviser license for that. Friday tells people it isn't a licensed
adviser, and never decides how much of their money to risk.

## Costs

- **Claude** is pay-as-you-go on your API key (there's no free tier). With Opus 5.5 a typical message costs roughly
  $0.01–0.04, and a document $0.05–0.15. Prompt caching keeps repeat context cheap. To spend less, set
  `FRIDAY_MODEL=claude-sonnet-5-5` (about half) or `claude-haiku-5-5` (much cheaper, less capable). Usage per message
  is printed in the console; your spend is on the [Claude Console](https://console.anthropic.com).
- **Pictures** are free with Cloudflare Workers AI: the free plan gives 10,000 "neurons" a day, about 90 images. If
  the allowance runs out, Friday says so and it resets the next day. (`IMAGE_PROVIDER=gemini` uses Google's Nano
  Banana instead — better at photo edits, but Google charges for every image; there's no free tier.)
- **WhatsApp** linking is free.

## Settings

All settings live in `.env` — see [`.env.example`](.env.example) for the full list (model, thinking effort, timezone,
bot name, limits). Restart Friday after changing them.

## Your data

Everything is in `data/` (not committed to git):

- `whatsapp-auth/` — the WhatsApp login. Delete it to unlink and scan again.
- `friday.db` — conversations, reminders, memories, contacts (SQLite)
- `images/` — photos and pictures, kept 30 days so they can be edited

Back up `data/` to keep everything when moving machines.

## Website

The landing page at https://fridayai.my.id lives in `website/` (Astro and GSAP) with its own `package.json`, so its
dependencies never reach the bot. It reads Friday's features from `catalog/items.json` and their example chats from
`website/src/content/demos.json`, which keeps the WhatsApp catalog and the site one list.

```bash
cd website
npm install
npm run dev     # needs the Node version in website/.nvmrc
npm test        # first time: npx playwright install chromium webkit
```

`scripts/deploy-website.sh` builds on your machine and copies the result to the server, because that server also runs
other production apps. On the server, `sudo /opt/friday/app/scripts/linux-service.sh web <domain>` writes the nginx
site: static files for the page, while `/privacy` and `/oauth/` go to Friday itself on `WEB_PORT`.

## Development

```bash
npm test          # unit + end-to-end tests (uses a fake Claude API; no key or cost)
npm run typecheck
npm run dev       # restart on file changes
```

Code map: `src/whatsapp.ts` (WhatsApp connection) → `src/bot.ts` (access, commands, attachments) → `src/agent.ts`
(Claude loop) → `src/tools.ts` (reminders, memory, documents, images, messages). Documents are rendered locally in
`src/docs/`; images go through `src/images.ts`; market analysis lives in `src/market/`.
