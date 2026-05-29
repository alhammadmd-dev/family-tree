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

## Notes
- Edits and any photos you upload in the app are saved in your own browser (localStorage); they are personal to your device, not pushed to the repo.
- To update the public tree for everyone, edit `family-tree-data.json` and re-upload it.
