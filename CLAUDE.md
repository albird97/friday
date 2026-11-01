# Friday

WhatsApp assistant built on Claude. See README.md for how it works.

## Shipping a feature

A feature is not done until the website knows about it. `npm test` fails when a new Claude tool or `/command` isn't
classified, but behaviour with neither (like understanding voice notes) relies on you, so check this list every time.

1. Classify every new tool and command in `website/src/content/feature-map.json`: a catalog id, `internal` (never
   shown) or `pending` (public later).
2. If people can use it, add it to `catalog/items.json` with its picture, and add a chat to
   `website/src/content/demos.json`. The ticker and feature picker pick it up by themselves.
3. If every contact can use it, update `src/welcome.ts`. Update the README either way.
4. Deploy with `scripts/deploy-website.sh`, and tell the admin to run `/katalog` on WhatsApp if the catalog changed.

Features limited to certain people, such as onehub, stay `internal`. Never put them, family names or personal numbers
on the website. The page makes no privacy promises of its own: it links to `/privacy`.

## Working on this repo

- Don't run `npm start` on this machine: the server holds the WhatsApp login, and two copies mean double replies.
- Start local commands with `ANTHROPIC_BASE_URL` unset: the Claude Code shell sets one that would hijack the API calls.
- The website has its own package in `website/` and needs the Node version in `website/.nvmrc`.
- The bot's server also runs production apps. Build the website here, never there, and change only Friday's nginx site.
