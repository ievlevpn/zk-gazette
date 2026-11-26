#!/usr/bin/env python3
"""
Gazette Daily Edition Generator (zero external Python dependencies — stdlib only).

Fetches:
  1. Live weather via Open-Meteo (free, no API key)
  2. Personal calendar (.ics URLs from Google Calendar / Apple iCloud)
  3. Monitored local event/concert pages (scraped & diffed against state.json for NEW badges)
  4. Curated RSS/Atom feeds
Then runs ONE compact curation call through `claude -p` or `gemini -p` (with deterministic fallback),
fetches clean full-text HTML for the chosen reads, renders the Edition JSON via `template.py`,
writes `today.json` + archive, and optionally pushes directly to a Kindle over SSH.

Usage:
  python3 generate.py --config config.json [--out today.json] [--no-llm] [--no-push]
"""

from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

# Ensure template.py and validate.py in the same folder are importable regardless of cwd.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import template  # noqa: E402
import validate  # noqa: E402

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gazette/0.2"

WMO_CODES = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Morning mist",
    48: "Freezing fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    80: "Rain showers",
    81: "Showers",
    82: "Heavy showers",
    95: "Thunderstorm",
}


# ───────────────────────────── HTTP & HTML Utilities ─────────────────────────────


class _Redirect308(urllib.request.HTTPRedirectHandler):
    def http_error_308(self, req: Any, fp: Any, code: int, msg: str, headers: Any) -> Any:
        return super().http_error_302(req, fp, 302, msg, headers)


_OPENER = urllib.request.build_opener(_Redirect308())


def http_get(url: str, timeout: int = 12, max_bytes: int = 1_500_000) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en,fr;q=0.9"})
    with _OPENER.open(req, timeout=timeout) as resp:
        data = resp.read(max_bytes)
        charset = resp.headers.get_content_charset() or "utf-8"
        return data.decode(charset, errors="replace")


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "iframe"}

    def __init__(self) -> None:
        super().__init__()
        self.depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t in self.SKIP:
            self.depth += 1
        elif self.depth == 0 and t in {"p", "br", "li", "h1", "h2", "h3", "h4", "tr", "div", "article", "section"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self.SKIP and self.depth > 0:
            self.depth -= 1

    def handle_data(self, data: str) -> None:
        if self.depth == 0:
            self.parts.append(data)

    def text(self) -> str:
        raw = html.unescape("".join(self.parts))
        lines = [re.sub(r"\s+", " ", ln).strip() for ln in raw.splitlines()]
        return "\n".join(ln for ln in lines if ln)


def html_to_text(markup: str) -> str:
    p = _TextExtractor()
    p.feed(markup)
    return p.text()


def strip_tags(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def clean_article_html(raw_html: str) -> str:
    """Extracts the main readable body HTML (paragraphs, headings, quotes, lists) stripped of scripts/chrome."""
    cleaned = re.sub(r"(?is)<(script|style|noscript|svg|iframe|form|nav|footer|aside|button)\b[^>]*>.*?</\1>", "", raw_html)
    # Prefer <article> or <main> if substantial.
    body = cleaned
    for tag in ("article", "main"):
        m = re.search(rf"(?is)<{tag}\b[^>]*>(.*?)</{tag}>", cleaned)
        if m and len(strip_tags(m.group(1))) > 400:
            body = m.group(1)
            break
    # Collect meaningful paragraphs / headings / blockquotes in document order.
    blocks = re.findall(r"(?is)<(p|h2|h3|blockquote|ul|ol)\b[^>]*>(.*?)</\1>", body)
    kept: list[str] = []
    for tag, inner in blocks:
        inner_clean = re.sub(r"(?is)<(?!/?(?:em|i|strong|b|a|li|code|br)\b)[^>]+>", "", inner).strip()
        plain = strip_tags(inner_clean)
        if len(plain) < (12 if tag in ("h2", "h3") else 35) and tag not in ("ul", "ol"):
            continue
        if any(bad in plain.lower() for bad in ("subscribe to", "sign up for our newsletter", "cookie policy", "all rights reserved")):
            continue
        kept.append(f"<{tag}>{inner_clean}</{tag}>")
        if len(kept) >= 45:
            break
    return "\n".join(kept)


def wrap_article_html(article: dict[str, Any], body_html: str) -> str:
    kicker = html.escape(article.get("kicker") or article.get("source") or "GAZETTE")
    title = html.escape(article.get("title", "Untitled"))
    byline = html.escape(
        " · ".join(
            x
            for x in [
                f"By {article['author']}" if article.get("author") else "",
                article.get("source", ""),
                article.get("readTime", ""),
                article.get("date", ""),
            ]
            if x
        )
    )
    deck = html.escape(article.get("summary", ""))
    why = html.escape(article.get("whyNote", ""))
    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{ font-family: Georgia, serif; line-height: 1.55; margin: 0 5%; color: #111; }}
  .kicker {{ font-family: sans-serif; font-size: 0.72em; letter-spacing: 0.14em; text-transform: uppercase; color: #555; margin-top: 1.2em; margin-bottom: 0.4em; }}
  h1 {{ font-size: 1.7em; line-height: 1.18; margin: 0 0 0.45em 0; font-weight: bold; }}
  .byline {{ font-family: sans-serif; font-size: 0.82em; color: #555; border-bottom: 1px solid #bbb; padding-bottom: 0.8em; margin-bottom: 1.1em; }}
  .deck {{ font-size: 1.06em; font-style: italic; color: #222; margin-bottom: 1.1em; }}
  .why {{ border-left: 3px solid #222; padding: 0.25em 0 0.25em 0.9em; margin: 1em 0 1.2em 0; font-family: sans-serif; font-size: 0.84em; color: #333; }}
  h2, h3 {{ margin-top: 1.4em; margin-bottom: 0.45em; }}
  blockquote {{ border-left: 3px solid #222; margin: 1.1em 0; padding: 0.2em 0 0.2em 1em; font-style: italic; }}
  a {{ color: #111; text-decoration: underline; }}
</style>
</head>
<body>
  <div class="kicker">{kicker}</div>
  <h1>{title}</h1>
  {f'<div class="byline">{byline}</div>' if byline else ''}
  {f'<p class="deck">{deck}</p>' if deck else ''}
  {f'<div class="why"><strong>Why today:</strong> {why}</div>' if why else ''}
  {body_html or f'<p>{deck}</p>'}
</body>
</html>"""


# ───────────────────────────── 1. Weather (Open-Meteo) ─────────────────────────────


def fetch_weather(cfg: dict[str, Any], tz: ZoneInfo) -> dict[str, Any]:
    wcfg = cfg.get("weather") or {}
    if wcfg.get("enabled") is False:
        return {"short": "", "days": []}
    lat = wcfg.get("latitude", 47.3769)
    lon = wcfg.get("longitude", 8.5417)
    url = (
        f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
        "&current=temperature_2m,weather_code"
        "&daily=weather_code,temperature_2m_min,temperature_2m_max"
        "&forecast_days=4&timezone=auto"
    )
    try:
        data = json.loads(http_get(url, timeout=10))
        cur = data.get("current", {})
        temp = round(cur.get("temperature_2m", 0))
        cond = WMO_CODES.get(int(cur.get("weather_code", 0)), "Clear")
        short = f"{temp}°C · {cond}"
        daily = data.get("daily", {})
        days = []
        for date_s, code, tmin, tmax in zip(
            daily.get("time", []),
            daily.get("weather_code", []),
            daily.get("temperature_2m_min", []),
            daily.get("temperature_2m_max", []),
        ):
            d = dt.date.fromisoformat(date_s)
            days.append(
                {
                    "day": d.strftime("%a"),
                    "temp": f"{round(tmin)}° / {round(tmax)}°",
                    "desc": WMO_CODES.get(int(code), "Clear"),
                }
            )
        return {"short": short, "days": days}
    except Exception as exc:
        print(f"[warn] weather fetch failed: {exc}", file=sys.stderr)
        return {"short": "", "days": []}


# ───────────────────────────── 2. Personal Calendar (.ics) ─────────────────────────────


def _unfold_ics(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw.startswith((" ", "\t")) and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def _parse_ics_dt(prop: str, val: str, local_tz: ZoneInfo) -> tuple[dt.datetime | None, bool]:
    val = val.strip()
    if "VALUE=DATE" in prop or (len(val) == 8 and val.isdigit()):
        try:
            d = dt.date(int(val[0:4]), int(val[4:6]), int(val[6:8]))
            return dt.datetime(d.year, d.month, d.day, 0, 0, tzinfo=local_tz), True
        except ValueError:
            return None, True
    tz = local_tz
    if val.endswith("Z"):
        tz = ZoneInfo("UTC")
        val = val[:-1]
    else:
        m = re.search(r"TZID=([^;:]+)", prop)
        if m:
            try:
                tz = ZoneInfo(m.group(1))
            except Exception:
                tz = local_tz
    try:
        parsed = dt.datetime.strptime(val[:15], "%Y%m%dT%H%M%S").replace(tzinfo=tz)
        return parsed.astimezone(local_tz), False
    except ValueError:
        return None, False


def _unescape_ics(s: str) -> str:
    return s.replace("\\n", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\").strip()


def fetch_calendar(cfg: dict[str, Any], now: dt.datetime, tz: ZoneInfo) -> dict[str, Any]:
    cal_cfg = cfg.get("calendar") or {}
    urls: list[str] = [u for u in cal_cfg.get("ics_urls", []) if isinstance(u, str) and u.strip()]
    today_date = now.date()
    horizon = today_date + dt.timedelta(days=int(cal_cfg.get("days_ahead", 7)))
    today_title = f"Today · {now.strftime('%a %-d %b')}"

    if not urls:
        return {
            "enabled": cal_cfg.get("enabled", True),
            "todayTitle": today_title,
            "sourceNote": "Add your Google or Apple Calendar private .ics URL in config.json to show live events.",
            "today": [],
            "upcoming": [],
        }

    events: list[tuple[dt.datetime, bool, dict[str, Any]]] = []
    for url in urls:
        try:
            raw = http_get(url, timeout=12)
        except Exception as exc:
            print(f"[warn] calendar fetch failed ({url[:40]}…): {exc}", file=sys.stderr)
            continue
        in_event = False
        cur: dict[str, tuple[str, str]] = {}
        for line in _unfold_ics(raw):
            if line == "BEGIN:VEVENT":
                in_event = True
                cur = {}
            elif line == "END:VEVENT" and in_event:
                in_event = False
                if "DTSTART" not in cur or "SUMMARY" not in cur:
                    continue
                if cur.get("STATUS", ("", ""))[1].upper() == "CANCELLED":
                    continue
                start_dt, all_day = _parse_ics_dt(cur["DTSTART"][0], cur["DTSTART"][1], tz)
                if not start_dt:
                    continue
                d = start_dt.date()
                if today_date <= d <= horizon:
                    summary = _unescape_ics(cur["SUMMARY"][1])
                    place = _unescape_ics(cur["LOCATION"][1]) if "LOCATION" in cur else ""
                    events.append(
                        (
                            start_dt,
                            all_day,
                            {
                                "day": start_dt.strftime("%a %-d %b"),
                                "time": "All day" if all_day else start_dt.strftime("%H:%M"),
                                "title": summary,
                                "place": place,
                            },
                        )
                    )
            elif in_event and ":" in line:
                prop, val = line.split(":", 1)
                key = prop.split(";", 1)[0].upper()
                cur[key] = (prop, val)

    events.sort(key=lambda x: (x[0].date(), not x[1], x[0]))
    today_items = [e[2] for e in events if e[0].date() == today_date]
    upcoming_items = [e[2] for e in events if e[0].date() > today_date][:12]
    return {
        "enabled": True,
        "todayTitle": today_title,
        "sourceNote": f"Synced from {len(urls)} calendar feed{'s' if len(urls) != 1 else ''} at {now.strftime('%H:%M')}.",
        "today": today_items,
        "upcoming": upcoming_items,
    }


# ───────────────────────────── 3. RSS / Atom Feeds ─────────────────────────────


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def fetch_rss_items(feeds: list[dict[str, Any]], max_per_feed: int = 5) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for f in feeds:
        url = f.get("url", "")
        if not url:
            continue
        source_name = f.get("name") or urllib.parse.urlparse(url).hostname or "Feed"
        default_kicker = f.get("kicker", source_name.upper())
        try:
            xml_text = http_get(url, timeout=12)
            root = ET.fromstring(xml_text.encode("utf-8", errors="ignore"))
        except Exception as exc:
            print(f"[warn] RSS failed ({source_name}): {exc}", file=sys.stderr)
            continue

        entries = [el for el in root.iter() if _local(el.tag) in ("item", "entry")][:max_per_feed]
        for el in entries:
            title = link = summary = content_html = author = pub = ""
            for child in el:
                tag = _local(child.tag)
                text = (child.text or "").strip()
                if tag == "title" and not title:
                    title = strip_tags(text)
                elif tag == "link" and not link:
                    link = child.attrib.get("href") or text
                elif tag in ("description", "summary") and not summary:
                    summary = text
                elif tag in ("encoded", "content") and not content_html:
                    content_html = text
                elif tag in ("creator", "author") and not author:
                    name_el = next((c for c in child if _local(c.tag) == "name"), None)
                    author = (name_el.text.strip() if name_el is not None and name_el.text else strip_tags(text))
                elif tag in ("pubdate", "published", "updated", "date") and not pub:
                    pub = text
            if not title:
                continue
            iso_date = ""
            if pub:
                try:
                    iso_date = email.utils.parsedate_to_datetime(pub).date().isoformat()
                except Exception:
                    iso_date = pub[:10]
            plain_summary = strip_tags(summary or content_html)[:420]
            aid = "art-" + hashlib.sha1((link or title).encode("utf-8")).hexdigest()[:10]
            items.append(
                {
                    "id": aid,
                    "title": title,
                    "source": source_name,
                    "kicker": default_kicker,
                    "author": author,
                    "date": iso_date,
                    "url": link,
                    "summary": plain_summary,
                    "feed_html": content_html if len(strip_tags(content_html)) > 500 else "",
                }
            )
    return items


# ───────────────────────────── 4. Concert / Event Watch Scraping ─────────────────────────────


def fetch_watch_pages(watches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    for w in watches:
        url = w.get("url", "")
        if not url:
            continue
        try:
            raw = http_get(url, timeout=14)
            text = html_to_text(raw)
            # Keep compact, high-signal slice for LLM extraction.
            pages.append(
                {
                    "name": w.get("name", url),
                    "venue": w.get("venue", w.get("name", "")),
                    "category": w.get("category", w.get("name", "")),
                    "url": url,
                    "text": text[:5500],
                }
            )
        except Exception as exc:
            print(f"[warn] watch scrape failed ({w.get('name', url)}): {exc}", file=sys.stderr)
    return pages


# ───────────────────────────── 4b. Drop-in Custom Sources (sources/) ─────────────────────────────


def run_custom_sources(
    sources_dir: Path,
    cfg_path: Path,
    state_path: Path,
    date_str: str,
) -> dict[str, list[dict[str, Any]]]:
    """Runs every non-underscore `.py` or executable script in `sources/` and merges stdout JSON."""
    merged: dict[str, list[dict[str, Any]]] = {
        "articles": [],
        "listings": [],
        "widgets": [],
        "tabs": [],
    }
    if not sources_dir.is_dir():
        return merged

    env = {
        **os.environ,
        "GAZETTE_CONFIG": str(cfg_path),
        "GAZETTE_DATE": date_str,
        "GAZETTE_STATE": str(state_path),
    }

    for entry in sorted(sources_dir.iterdir()):
        if not entry.is_file() or entry.name.startswith(("_", ".")):
            continue
        if entry.suffix == ".py":
            cmd = [sys.executable, str(entry)]
        elif os.access(entry, os.X_OK):
            cmd = [str(entry)]
        else:
            continue

        try:
            proc = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=20,
                env=env,
                check=False,
            )
            if proc.returncode != 0:
                print(
                    f"[warn] source {entry.name} exited {proc.returncode}: {proc.stderr.strip()[:240]}",
                    file=sys.stderr,
                )
                continue
            raw_out = proc.stdout.strip()
            if not raw_out:
                continue
            data = json.loads(raw_out)
            if not isinstance(data, dict):
                print(f"[warn] source {entry.name} stdout must be a JSON object", file=sys.stderr)
                continue
            counts: list[str] = []
            for key in ("articles", "listings", "widgets", "tabs"):
                items = data.get(key)
                if isinstance(items, list):
                    valid_items = [x for x in items if isinstance(x, dict)]
                    merged[key].extend(valid_items)
                    if valid_items:
                        counts.append(f"{len(valid_items)} {key}")
            if counts:
                print(f"[ok] source {entry.name}: {', '.join(counts)}")
        except Exception as exc:
            print(f"[warn] source {entry.name} failed: {exc}", file=sys.stderr)
    return merged


# ───────────────────────────── 5. Single Daily LLM Curation Pass ─────────────────────────────


def run_llm_curation(
    cfg: dict[str, Any],
    now: dt.datetime,
    rss_candidates: list[dict[str, Any]],
    watch_pages: list[dict[str, Any]],
    calendar_today: list[dict[str, Any]],
) -> dict[str, Any] | None:
    llm_mode = (cfg.get("llm") or "auto").lower()
    if llm_mode == "none":
        return None

    claude_bin = shutil.which("claude")
    gemini_bin = shutil.which("gemini")
    candidates: list[tuple[str, list[str]]] = []
    if llm_mode == "claude" and claude_bin:
        candidates.append(("claude", [claude_bin, "-p", "--output-format", "text"]))
    elif llm_mode == "gemini" and gemini_bin:
        candidates.append(("gemini", [gemini_bin, "-p"]))
    elif llm_mode == "auto":
        if claude_bin:
            candidates.append(("claude", [claude_bin, "-p", "--output-format", "text"]))
        if gemini_bin:
            candidates.append(("gemini", [gemini_bin, "-p"]))

    if not candidates:
        print("[info] no claude/gemini CLI found on PATH; using deterministic curation.", file=sys.stderr)
        return None

    compact_rss = [
        {
            "id": a["id"],
            "source": a["source"],
            "title": a["title"],
            "author": a["author"],
            "date": a["date"],
            "summary": a["summary"][:260],
        }
        for a in rss_candidates[:24]
    ]
    compact_watches = [
        {"name": p["name"], "venue": p["venue"], "category": p["category"], "url": p["url"], "excerpt": p["text"][:3200]}
        for p in watch_pages
    ]

    prompt = f"""You are the editor of a calm, personal e-ink morning newspaper ("{cfg.get('title', 'THE GAZETTE')}").
Today is {now.strftime('%A, %d %B %Y')} in {cfg.get('city', 'your city')}.
Reader profile & interests: {cfg.get('interests', 'Long-form essays on history, science, literature, philosophy, craft, and local cultural events.')}

Return ONLY valid JSON (no markdown fences, no commentary) with this exact structure:
{{
  "picks": [
    {{
      "id": "<id from RSS candidates>",
      "lead": true,
      "kicker": "<SHORT UPPERCASE KICKER, 2-3 words>",
      "summary": "<crisp 2-sentence front-page deck, <= 190 chars, ends with a period>",
      "whyNote": "<1 short personal sentence explaining why this made today's edition>",
      "tags": ["tag1", "tag2"]
    }}
  ],
  "concerts": [
    {{
      "id": "<stable slug like event-2026-11-29-venue-title>",
      "when": "<e.g. Sun 29 Nov · 17:00>",
      "venue": "<venue name>",
      "category": "<short filter chip: venue, topic, or neighborhood>",
      "title": "<event title>",
      "subtitle": "<performer, speaker, or organizer>",
      "meta": "<price / free / registration>",
      "summary": "<program or event overview, 1-2 sentences>",
      "note": "<short editorial note for the reader>",
      "url": "<source url>"
    }}
  ],
  "quote": {{
    "text": "<1-2 sentence literary, musical, or philosophical epigraph>",
    "source": "<author or work>"
  }}
}}

Rules:
- Pick 4 articles from RSS candidates (most interesting and diverse across sources). Exactly 1 has "lead": true.
- Extract up to 6 genuinely UPCOMING events on or after {now.strftime('%Y-%m-%d')} from the watch excerpts (skip past dates, invent nothing not supported by the text; return [] if no watch pages were given).
- Keep summaries tight and complete sentences (no trailing ellipses).

Today's calendar: {json.dumps(calendar_today, ensure_ascii=False)}
RSS candidates: {json.dumps(compact_rss, ensure_ascii=False)}
Watched event pages: {json.dumps(compact_watches, ensure_ascii=False)}
"""

    for name, cmd in candidates:
        try:
            if name == "gemini":
                proc = subprocess.run(
                    [cmd[0], "-p", prompt],
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    text=True,
                    timeout=90,
                    check=False,
                )
            else:
                proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=90, check=False)
            if proc.returncode != 0:
                print(f"[warn] {name} CLI exited {proc.returncode}: {proc.stderr[:260]}", file=sys.stderr)
                continue
            out = proc.stdout.strip()
            m = re.search(r"\{[\s\S]*\}", out)
            if not m:
                print(f"[warn] {name} output contained no JSON object", file=sys.stderr)
                continue
            print(f"[ok] curated edition via {name} CLI")
            return json.loads(m.group(0))
        except Exception as exc:
            print(f"[warn] {name} curation failed: {exc}", file=sys.stderr)
    return None


# ───────────────────────────── 6. Main Pipeline ─────────────────────────────


def load_state(path: Path) -> dict[str, Any]:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"edition_num": 0, "seen_concerts": [], "seen_articles": []}


def build_articles(
    rss_candidates: list[dict[str, Any]],
    llm_data: dict[str, Any] | None,
    seen_articles: set[str],
    fetch_full_html: bool = True,
    pinned_articles: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    by_id = {a["id"]: a for a in rss_candidates}
    chosen: list[dict[str, Any]] = []
    if pinned_articles:
        for a in pinned_articles:
            aid = str(a.get("id") or "custom-" + hashlib.sha1(str(a.get("title", "")).encode("utf-8")).hexdigest()[:10])
            chosen.append({**a, "id": aid})
    if llm_data and isinstance(llm_data.get("picks"), list):
        for p in llm_data["picks"]:
            base = by_id.get(p.get("id", ""))
            if not base or any(c["id"] == base["id"] for c in chosen):
                continue
            chosen.append(
                {
                    **base,
                    "lead": bool(p.get("lead")),
                    "kicker": p.get("kicker") or base["kicker"],
                    "summary": p.get("summary") or base["summary"],
                    "whyNote": p.get("whyNote", ""),
                    "tags": p.get("tags") or [],
                }
            )
    if len(chosen) < 4 and rss_candidates:
        # Deterministic diverse fallback: 1 from each source first.
        seen_src: set[str] = {c.get("source", "") for c in chosen if c.get("source")}
        for a in rss_candidates:
            if any(c["id"] == a["id"] for c in chosen):
                continue
            if a["source"] not in seen_src:
                seen_src.add(a["source"])
                chosen.append(dict(a))
            if len(chosen) >= 4:
                break
        if len(chosen) < 4:
            for a in rss_candidates:
                if all(c["id"] != a["id"] for c in chosen):
                    chosen.append(dict(a))
                if len(chosen) >= 4:
                    break

    if chosen and not any(c.get("lead") for c in chosen):
        chosen[0]["lead"] = True

    final_articles: list[dict[str, Any]] = []
    limit = max(5, len(pinned_articles or []) + 4)
    for a in chosen[:limit]:
        custom_html = a.get("html") if isinstance(a.get("html"), str) and a["html"].strip() else ""
        body_html = ""
        if not custom_html:
            if a.get("feed_html"):
                body_html = clean_article_html(a["feed_html"])
            elif fetch_full_html and a.get("url"):
                try:
                    body_html = clean_article_html(http_get(a["url"], timeout=10))
                except Exception as exc:
                    print(f"[warn] full text fetch skipped ({a.get('url')}): {exc}", file=sys.stderr)
        word_count = len(strip_tags(custom_html or body_html or a.get("summary", "")).split())
        read_min = max(2, round(word_count / 230))
        art = {
            "id": a["id"],
            "lead": bool(a.get("lead")),
            "isNew": bool(a.get("isNew")) if "isNew" in a else (a["id"] not in seen_articles),
            "kicker": a.get("kicker", "READ"),
            "title": a["title"],
            "source": a.get("source", ""),
            "author": a.get("author", ""),
            "date": a.get("date", ""),
            "url": a.get("url", ""),
            "readTime": a.get("readTime") or f"{read_min} min read",
            "summary": a.get("summary", ""),
            "whyNote": a.get("whyNote", ""),
            "tags": a.get("tags", []),
        }
        art["html"] = custom_html or wrap_article_html(art, body_html)
        final_articles.append(art)
    return final_articles


def parse_concerts_fallback(watch_pages: list[dict[str, Any]], today: dt.date) -> list[dict[str, Any]]:
    """Deterministic parser for Swiss DD.MM.YYYY concert schedules when LLM curation is unavailable."""
    out: list[dict[str, Any]] = []
    date_re = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})(?:\s*[—–-]\s*(\d{2}:\d{2}))?")
    time_re = re.compile(r"(?:à\s*)?(\d{2}:\d{2})")
    for p in watch_pages:
        lines = [ln.strip() for ln in p["text"].splitlines() if ln.strip()]
        for i, ln in enumerate(lines):
            m = date_re.match(ln)
            if not m:
                continue
            try:
                d = dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            except ValueError:
                continue
            if d < today:
                continue
            time_str = m.group(4) or ""
            j = i + 1
            if not time_str and j < len(lines):
                tm = time_re.search(lines[j])
                if tm and len(lines[j]) <= 16:
                    time_str = tm.group(1)
                    j += 1
            venue = p.get("venue", p["name"])
            if j < len(lines) and any(
                k in lines[j]
                for k in ("Hall", "Cathedral", "Church", "Museum", "Theatre", "Theater", "Cathédrale", "Église", "Temple")
            ):
                venue = lines[j].split(" Place ")[0].strip()
                j += 1
            if j >= len(lines):
                continue
            title = lines[j]
            if title.lower() in ("lire la suite", "voir tout", "billetterie") or len(title) < 4:
                continue
            when = f"{d.strftime('%a %-d %b')}{' · ' + time_str if time_str else ''}"
            slug = hashlib.sha1(f"{d.isoformat()}|{venue}|{title}".encode("utf-8")).hexdigest()[:10]
            out.append(
                {
                    "id": f"watch-{d.isoformat()}-{slug}",
                    "when": when,
                    "venue": venue,
                    "category": p.get("category", ""),
                    "title": title,
                    "subtitle": p.get("name", ""),
                    "meta": "See venue site",
                    "summary": f"Listed on {p['name']} for {when}.",
                    "note": "",
                    "url": p["url"],
                    "_date": d.isoformat(),
                }
            )
    out.sort(key=lambda x: x.pop("_date", "9999"))
    # Deduplicate by title + when
    deduped: list[dict[str, Any]] = []
    seen_k: set[tuple[str, str]] = set()
    for c in out:
        k = (c["when"], c["title"])
        if k not in seen_k:
            seen_k.add(k)
            deduped.append(c)
    return deduped[:8]


def build_concerts(
    llm_data: dict[str, Any] | None,
    watch_pages: list[dict[str, Any]],
    today: dt.date,
    seen_concerts: set[str],
    extra_listings: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    raw = llm_data.get("concerts", []) if (llm_data and isinstance(llm_data.get("concerts"), list)) else []
    if not raw:
        raw = parse_concerts_fallback(watch_pages, today)
    combined = [*(extra_listings or []), *raw]
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for idx, c in enumerate(combined[:12]):
        if not isinstance(c, dict) or not c.get("title"):
            continue
        cid = str(c.get("id") or f"watch-{idx}-{hashlib.sha1(c['title'].encode()).hexdigest()[:8]}")
        if cid in seen_ids:
            continue
        seen_ids.add(cid)
        item: dict[str, Any] = {
            "id": cid,
            "isNew": bool(c.get("isNew")) if "isNew" in c else (cid not in seen_concerts),
            "when": str(c.get("when", "")),
            "venue": str(c.get("venue", "")),
            "category": str(c.get("category", "")),
            "title": str(c.get("title", "")),
            "subtitle": str(c.get("subtitle", "")),
            "meta": str(c.get("meta", "")),
            "summary": str(c.get("summary", "")),
            "note": str(c.get("note", "")),
            "url": str(c.get("url", "")),
        }
        if isinstance(c.get("details"), list):
            item["details"] = c["details"]
        if isinstance(c.get("html"), str) and c["html"].strip():
            item["html"] = c["html"]
        out.append(item)
    return out


def push_to_kindle(out_path: Path, push_cfg: dict[str, Any]) -> None:
    host = push_cfg.get("ssh_host", "").strip()
    remote_path = push_cfg.get("remote_path", "").strip()
    if not host or not remote_path:
        return
    remote_dir = str(Path(remote_path).parent)
    try:
        subprocess.run(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", host, f"mkdir -p '{remote_dir}'"],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        subprocess.run(
            ["scp", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", str(out_path), f"{host}:{remote_path}"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        print(f"[ok] pushed edition to {host}:{remote_path}")
    except Exception as exc:
        print(f"[info] Kindle push skipped (offline or unreachable): {exc}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate a Gazette daily Edition JSON.")
    ap.add_argument("--config", default=str(HERE / "config.json"), help="Path to config.json")
    ap.add_argument("--out", default="", help="Output path for today.json (overrides config.output)")
    ap.add_argument("--no-llm", action="store_true", help="Skip claude/gemini CLI and use deterministic curation")
    ap.add_argument("--no-push", action="store_true", help="Skip pushing to Kindle over SSH")
    args = ap.parse_args()

    cfg_path = Path(args.config).expanduser().resolve()
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    if args.no_llm:
        cfg["llm"] = "none"

    tz = ZoneInfo(cfg.get("timezone", "Europe/Zurich"))
    now = dt.datetime.now(tz)
    out_path = Path(args.out or cfg.get("output") or (cfg_path.parent / "today.json")).expanduser().resolve()
    state_path = Path(cfg.get("state_file") or (cfg_path.parent / "state.json")).expanduser().resolve()
    state = load_state(state_path)

    print(f"[gazette] generating edition for {now.strftime('%Y-%m-%d %H:%M %Z')}…")
    weather = fetch_weather(cfg, tz)
    agenda = fetch_calendar(cfg, now, tz)
    rss_candidates = fetch_rss_items(cfg.get("feeds", []), max_per_feed=int(cfg.get("max_per_feed", 5)))
    watch_pages = fetch_watch_pages(cfg.get("watches", []))

    sources_dir = Path(cfg.get("sources_dir") or (cfg_path.parent / "sources")).expanduser().resolve()
    custom = run_custom_sources(sources_dir, cfg_path, state_path, now.strftime("%Y-%m-%d"))
    pinned_articles: list[dict[str, Any]] = []
    for a in custom["articles"]:
        if not a.get("title"):
            continue
        normalized = {
            **a,
            "id": str(a.get("id") or "custom-" + hashlib.sha1(str(a["title"]).encode("utf-8")).hexdigest()[:10]),
            "source": str(a.get("source", "Custom")),
            "kicker": str(a.get("kicker", "CUSTOM")),
            "author": str(a.get("author", "")),
            "date": str(a.get("date", now.strftime("%Y-%m-%d"))),
            "summary": str(a.get("summary", "")),
        }
        if a.get("keep"):
            pinned_articles.append(normalized)
        else:
            rss_candidates.append(normalized)

    print(f"[gazette] fetched {len(rss_candidates)} RSS items, {len(watch_pages)} watch pages, {len(agenda['today'])} events today.")

    llm_data = run_llm_curation(cfg, now, rss_candidates, watch_pages, agenda["today"])
    seen_articles = set(state.get("seen_articles", []))
    seen_concerts = set(state.get("seen_concerts", []))

    articles = build_articles(rss_candidates, llm_data, seen_articles, pinned_articles=pinned_articles)
    concerts = build_concerts(llm_data, watch_pages, now.date(), seen_concerts, extra_listings=custom["listings"])
    quote = (llm_data or {}).get("quote") or {
        "text": "Reading is a conversation with the finest minds of past centuries.",
        "source": "René Descartes",
    }

    edition_num = int(state.get("edition_num", 0)) + 1
    ctx = {
        "config": cfg,
        "edition_id": now.strftime("%Y-%m-%d"),
        "edition_number": f"No. {edition_num:03d}",
        "date_line": now.strftime("%A, %-d %B %Y"),
        "subtitle": f"Curated at {now.strftime('%H:%M')} · {os.uname().nodename.split('.')[0]}",
        "weather": weather,
        "agenda": agenda,
        "concerts": concerts,
        "articles": articles,
        "quote": quote,
        "extra_widgets": custom["widgets"],
        "extra_tabs": custom["tabs"],
    }
    edition = template.build_edition(ctx)

    val_errors, val_warnings = validate.validate_edition(edition)
    for w in val_warnings:
        print(f"[validate warn] {w}", file=sys.stderr)
    for e in val_errors:
        print(f"[validate error] {e}", file=sys.stderr)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(edition, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(out_path)

    archive_dir = out_path.parent / "editions"
    archive_dir.mkdir(parents=True, exist_ok=True)
    (archive_dir / f"{now.strftime('%Y-%m-%d')}.json").write_text(out_path.read_text(encoding="utf-8"), encoding="utf-8")

    # Persist seen IDs so tomorrow only flags genuinely new items.
    state["edition_num"] = edition_num
    state["seen_articles"] = list(dict.fromkeys([*state.get("seen_articles", []), *(a["id"] for a in articles)]))[-300:]
    state["seen_concerts"] = list(dict.fromkeys([*state.get("seen_concerts", []), *(c["id"] for c in concerts)]))[-200:]
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        f"[ok] wrote {out_path} ({out_path.stat().st_size // 1024} KB): "
        f"{len(articles)} articles, {len(concerts)} watch listings, {len(agenda['today'])} today events."
    )

    if not args.no_push and cfg.get("push_ssh"):
        push_to_kindle(out_path, cfg["push_ssh"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
