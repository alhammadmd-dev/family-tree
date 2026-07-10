# شجرة العائلة — الوزرة (Al-Wazrah Family Tree)

Interactive Arabic family tree (927 people, 9 generations) rebuilt from the original chart, with photos and verified links. Runs as a static site, no build step.

## Files
- `index.html` — the app (React via CDN, runs in any browser)
- `family-tree-data.json` — the tree data (names, links, photos)
- `.nojekyll` — tells GitHub Pages to serve files as-is

## Publish on GitHub Pages
1. Create a new repository on GitHub (e.g. `family-tree`), Public.
2. Upload these three files to the repo root (drag-and-drop in the GitHub web UI works).
3. Go to **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Branch: `main`, folder: `/ (root)`. Save.
6. Wait ~1 minute. Your site will be live at:
   `https://<your-username>.github.io/<repo-name>/`

## Family mode (الوضع العائلي)

Sensitive data — dates of birth, contact details (WhatsApp / LinkedIn / X), and the
female members of the tree — is hidden until the visitor enters the shared family
passcode via the **🔒 الوضع العائلي** button in the header.

- The current passcode is `wazrah2026` — **change it before sharing the site**.
- To change it: open the site, open the browser console, run
  `await sha256hex("your-new-code")`, and paste the resulting hash into the
  `FAMILY_CODE_HASH` constant in `index.html`.
- ⚠️ This gate deters casual visitors only. The raw `family-tree-data.json` is still
  publicly downloadable, so anyone technical who has the URL can read its contents.
  Don't store anything there that must stay truly private.

## Person fields

Each person in `family-tree-data.json` supports (all optional except `id`/`name`):
`nickname` (الكنية), `gender` (`"m"`/`"f"`), `dob` (year or full date), `dod` (year of
death), `deceased`, `elderly`, `contacts` (`{whatsapp, linkedin, twitter}`), and `poc`
(the id of a living relative shown as point of contact for deceased/elderly members).
Edges support `type: "spouse"` for marriage links; parent→child edges need no type.

## Updating the published tree

- Edits and any photos you upload in the app are saved in your own browser (localStorage); they are personal to your device, not pushed to the repo.
- To update the public tree for everyone, edit `family-tree-data.json`, **increment its
  top-level `version` number**, and re-upload it. Visitors with an older local copy get
  a banner offering to update to the new official version.
