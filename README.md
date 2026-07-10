# شجرة العائلة — الوزرة (Al-Wazrah Family Tree)

Interactive Arabic family tree (927 people, 9 generations) rebuilt from the original chart, with photos and verified links. Runs as a static site, no build step.

## Files
- `index.html` — the app (React via CDN, runs in any browser)
- `family-tree-data.json` — the tree data (names, links, fields) — small, loads first
- `family-tree-photos.json` — the photo pack (base64 images), fetched lazily after the tree renders
- `.nojekyll` — tells GitHub Pages to serve files as-is

## Navigation
- **Minimap** (bottom-right): shows the whole tree with the current viewport; click or drag to jump anywhere.
- **Deep links**: every person has a shareable URL (`…/#p=<id>`) — use the "نسخ رابط" button in their profile. Opening the link focuses the tree on that person. Links to female members only resolve in family mode.
- On phones the panel opens as a bottom sheet; swipe-handle tap closes it.

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

## Live shared tree (Firebase)

The app connects to Firebase project `family-tree-alwazrah` (Firestore). Once the
database is seeded, the tree becomes **shared and live**: every edit and photo upload
is stored centrally, appears for all visitors within a second, and is recorded in a
wiki-style history (السجل) with editor attribution and one-click revert.

**Editing requires sign-in**: family members sign in with Google and request edit
access; the admin (`alhammad.md@gmail.com`) approves them in the الإدارة tab.
Viewing stays public, with the sensitive layer still behind the family code.

One-time console setup (Firebase console → project):
1. **Firestore Database** — create it (done).
2. **Rules** — paste the contents of `firestore.rules` and Publish.
3. **Authentication → Sign-in method** — enable **Google**.
4. **Authentication → Settings → Authorized domains** — add `alhammadmd-dev.github.io`.
5. Open the site, sign in with the admin account, and click **"رفع البيانات إلى السحابة"**.

If Firebase is unreachable or not yet seeded, the app automatically falls back to the
static JSON files below (read-mostly, per-device localStorage editing as before).

## Updating the published tree (fallback mode only)

- In fallback mode, edits and photos live in each visitor's browser (localStorage).
- To update the static tree, edit `family-tree-data.json`, **increment its top-level
  `version` number**, and re-upload it. Visitors with an older local copy get a banner
  offering to update.
- Once the cloud is live these static files serve only as the emergency fallback —
  refresh them occasionally from the "تصدير" backup.
