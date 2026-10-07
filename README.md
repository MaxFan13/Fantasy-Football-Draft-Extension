# Sleeper Draft Assistant

A Chrome side-panel extension that shows the best available players by position
during your Sleeper fantasy **football or basketball** draft, powered by
[FantasyPros NFL](https://www.fantasypros.com/nfl/rankings/consensus-cheatsheets.php)
and [FantasyPros NBA](https://www.fantasypros.com/nba/rankings/overall.php)
consensus rankings.

Drafted players are crossed off your board automatically in real time — no clicking required.

## Install (unpacked extension)

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (toggle, top right)
3. Click **Load unpacked** and select this folder (`sleeper-draft-assistant`)
4. Pin the extension (puzzle-piece icon → pin) so it's one click away

## Use

1. Click the extension icon — the side panel opens next to the page
2. Pick your sport (NFL / NBA) and league scoring format — NFL: Half PPR /
   PPR / Standard; NBA: Roto-Categories or Points (ESPN / Yahoo / CBS) — and
   click **Fetch rankings** — it pulls the live FantasyPros consensus cheatsheet
   - Alternatively, expand "Or upload the FantasyPros CSV instead" and load a
     CSV downloaded from the FantasyPros rankings page
3. Open your Sleeper draft room in a tab and click **Connect** — the panel
   grabs the draft ID from the tab URL. (You can also paste the draft URL or
   ID manually in settings.)
4. Draft. The panel polls Sleeper every 5 seconds:
   - The top grid always shows the **best available player at each position**
   - The list below shows full rankings with FantasyPros tiers (NFL only —
     FantasyPros doesn't publish NBA tiers in its data feed); use the
     position tabs (NFL: QB/RB/WR/TE/FLX/K/DST; NBA: G/F/C, with each
     player's finer eligibility like `PG,SG` shown in the row) and search box
   - Drafted players disappear (or show struck-through if you uncheck
     *Hide drafted*)

Re-fetch rankings any time (e.g. right before the draft) to pick up the latest
consensus. Rankings and your draft connection are remembered between sessions.

## How it works

- **Rankings**: fetches the FantasyPros cheatsheet page and reads the
  `ecrData` JSON embedded in it (rank, tier, position rank, team, bye week).
  CSV upload is a fallback that parses the same columns.
- **Draft sync (instant)**: a content script in the Sleeper draft tab
  observes the draft room's own live WebSocket feed and mirrors pick events
  to the panel the moment they happen (observation only — it never sends or
  changes anything). Requires the draft tab to be open, which it is anyway.
- **Draft sync (backup)**: Sleeper's free public read-only API
  (`api.sleeper.app/v1/draft/{draft_id}/picks`) is polled every 3 seconds
  with cache-busting as the source of truth, so nothing is missed even if
  the live feed's message format changes.
- **Matching**: player names are normalized (accents folded — Sleeper's
  "Jokić" / "Dončić" / "Şengün" match FantasyPros' "Jokic" / "Doncic" /
  "Sengun" — plus punctuation and Jr./III-style suffixes stripped) and
  matched by name + position, with a name-only fallback. Sleeper `DEF` picks
  map to FantasyPros `DST` rows; NBA `PG/SG/SF/PF` fold to FantasyPros'
  `G/F/C` buckets.

## Files

- `manifest.json` — MV3 manifest (side panel, storage, Sleeper + FantasyPros hosts)
- `background.js` — opens the side panel on toolbar click
- `inject.js` / `relay.js` — observe the draft room's live feed for instant pick updates
- `panel.html` / `panel.css` / `panel.js` — the entire UI and logic

After changing or updating the extension, hit the reload icon on
`chrome://extensions` **and refresh the Sleeper draft tab** so the live-feed
scripts re-attach.
