# Drop-in Custom Sources (`generator/sources/`)

Add your own scrapers, custom Front Page widgets, or custom tabs without modifying `generate.py` or `template.py`.

## How It Works

When `generate.py` runs, it scans the `sources/` directory next to your `config.json` (in alphabetical order) and runs every script that:

- ends in `.py` (run with the same `python3` interpreter), **or** is an executable file (`chmod +x`), **and**
- does **not** start with `_` or `.` (so `_example_*.py` files are skipped until you copy/rename them).

Each script receives these environment variables:

| Variable | Value |
| --- | --- |
| `GAZETTE_CONFIG` | Absolute path to `config.json` |
| `GAZETTE_DATE` | Edition date (`YYYY-MM-DD`) |
| `GAZETTE_STATE` | Absolute path to `state.json` |

### Output Contract (stdout JSON)

Print a single JSON object to **stdout** with any subset of these keys:

```json
{
  "articles": [
    {
      "id": "my-article-1",
      "title": "Headline",
      "source": "My Scraper",
      "kicker": "CUSTOM",
      "url": "https://example.com/post",
      "summary": "Short front-page deck.",
      "keep": true
    }
  ],
  "listings": [
    {
      "id": "my-event-1",
      "when": "Fri 27 Nov · 19:00",
      "venue": "Local Hall",
      "category": "Talk",
      "title": "Evening Lecture",
      "summary": "Short overview."
    }
  ],
  "widgets": [
    {
      "id": "my-facts",
      "kind": "facts",
      "title": "At a Glance",
      "items": [{ "label": "Books read", "value": "14", "note": "this year" }]
    }
  ],
  "tabs": [
    {
      "id": "custom-tab",
      "title": "Notes",
      "kind": "custom",
      "blocks": [
        { "kind": "text", "text": "CUSTOM SECTION", "style": "label", "caps": true },
        {
          "kind": "box",
          "border": "thin",
          "pad": "medium",
          "radius": "small",
          "child": { "kind": "text", "text": "Any declarative GazetteNode block tree.", "font": "serif", "size": "body" }
        }
      ]
    }
  ]
}
```

### Key Details

- **`articles`**: Set `"keep": true` on an article to always include it in today's edition (bypassing LLM filtering); omit `"keep"` (or set `false`) to let it compete alongside your RSS feeds during curation. Include `"html"` if your scraper already extracted clean article HTML; otherwise `generate.py` fetches & cleans `url`.
- **`listings`**: Merged into the Watch/Events tab and widget automatically, with `NEW` badge diffing via `state.json`.
- **`widgets`**: Appended to your Front Page widget rail (`facts`, `note`, `quote`, `weather`, `agenda`, `listings`, or `custom` with a `GazetteNode` tree).
- **`tabs`**: Appended to the top tab bar (`articles`, `listings`, `agenda`, `briefs`, or `custom`). Keep total tabs ≤ 4 so every tab appears in the segmented bar.
- **Pagination tip for `custom` tabs**: Put each card directly in `blocks` (a flat list of blocks) rather than wrapping all cards in one outer `column`, so Gazette's multi-page e-ink pager can split between cards cleanly.

## Quick Test

Test any source script in isolation before running the full generator:

```sh
python3 generator/sources/_example_facts_widget.py | python3 -m json.tool
```

Then validate a generated edition:

```sh
python3 generator/validate.py today.json
```
