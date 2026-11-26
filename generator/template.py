"""
Server-side layout template for Gazette (`edition: 1`).

Edit this file (or ask an AI agent to edit it!) to redecorate your Gazette without touching
any scraper or Kindle plugin code.

Available declarative Front Page node kinds (rendered natively via zk.ui on the Kindle):
  - {"kind": "column", "gap": "none|xsmall|small|medium|large", "width": "fill|auto|60%", "children": [...]}
  - {"kind": "row", "gap": "...", "align": "top|center|bottom|stretch", "width": "...", "children": [...]}
  - {"kind": "box", "border": "none|thin|thick", "fill": "none|light|ink", "pad": "...", "radius": "none|small|round",
     "openArticle"|"openListing"|"openTab": "...", "child": {...}}
  - {"kind": "text", "text": "...", "font": "serif|sans", "weight": "regular|medium|bold",
     "size": "xsmall|small|body|large|title", "tone": "ink|secondary", "align": "start|center|end",
     "caps": bool, "italic": bool, "lines": int, "openArticle"|"openTab"|"saveArticle": "..."}
  - {"kind": "pill", "text": "NEW", "width": "14%", "tone": "ink|light"}
  - {"kind": "divider" | "space" | "spacer"}
  - {"kind": "quote", "text": "...", "source": "..."}
  - {"kind": "widget", "widgetId": "agenda" | "organ" | "weather" | "quote" | ...}
  - {"kind": "article", "articleId": "...", "variant": "lead" | "dispatch"}
"""

from __future__ import annotations
from typing import Any


def _article_column(articles: list[dict[str, Any]], width: str = "60%") -> dict[str, Any]:
    children: list[dict[str, Any]] = []
    lead = next((a for a in articles if a.get("lead")), articles[0] if articles else None)
    rest = [a for a in articles if a is not lead][:3]
    if lead:
        children.append({"kind": "article", "articleId": lead["id"], "variant": "lead"})
        if rest:
            children.append({"kind": "divider"})
            children.append({"kind": "text", "text": "DISPATCHES & CURATED READS", "style": "label", "caps": True})
    for idx, a in enumerate(rest):
        children.append({"kind": "article", "articleId": a["id"], "variant": "dispatch"})
        if idx < len(rest) - 1:
            children.append({"kind": "divider"})
    return {"kind": "column", "gap": "small", "width": width, "children": children}


def build_edition(ctx: dict[str, Any]) -> dict[str, Any]:
    """Assembles the final Gazette Edition JSON from fetched & curated data."""
    cfg = ctx["config"]
    articles: list[dict[str, Any]] = ctx["articles"]
    concerts: list[dict[str, Any]] = ctx["concerts"]
    agenda: dict[str, Any] = ctx["agenda"]
    weather: dict[str, Any] = ctx["weather"]
    quote: dict[str, Any] | None = ctx.get("quote")

    # Modular widgets — reorder, add, or remove freely!
    widgets: list[dict[str, Any]] = []
    if agenda.get("enabled", True):
        widgets.append(
            {
                "id": "agenda",
                "kind": "agenda",
                "title": agenda.get("todayTitle", "Today"),
                "tabId": "calendar",
                "today": agenda.get("today", []),
                "upcoming": agenda.get("upcoming", []),
                "maxToday": 4,
                "maxUpcoming": 3,
            }
        )
    if concerts:
        widgets.append(
            {
                "id": "watch",
                "kind": "listings",
                "title": cfg.get("watch_rail_title", "Event Watch"),
                "tabId": "watch",
                "items": concerts,
                "maxItems": 3,
            }
        )
    elif weather.get("days"):
        widgets.append(
            {
                "id": "weather",
                "kind": "weather",
                "title": f"Weather · {cfg.get('city', 'Local')}",
                "current": weather.get("short", ""),
                "days": weather.get("days", []),
            }
        )
    if quote and quote.get("text"):
        widgets.append(
            {
                "id": "quote",
                "kind": "quote",
                "title": "Epigraph",
                "text": quote["text"],
                "source": quote.get("source", ""),
            }
        )

    # Tabs shown across the segmented navigation bar.
    tabs: list[dict[str, Any]] = [
        {
            "id": "reads",
            "title": "Reads",
            "kind": "articles",
            "heading": "Curated Reads · Opens in Preview",
            "items": articles,
        }
    ]
    if concerts:
        tabs.append(
            {
                "id": "watch",
                "title": cfg.get("watch_tab_title", "Events"),
                "kind": "listings",
                "heading": cfg.get("watch_heading", "Upcoming Local Events"),
                "railTitle": cfg.get("watch_rail_title", "Event Watch"),
                "items": concerts,
            }
        )
    tabs.append(
        {
            "id": "calendar",
            "title": "Calendar",
            "kind": "agenda",
            "todayTitle": agenda.get("todayTitle", "Today"),
            "upcomingTitle": "Next 7 Days",
            "forecastTitle": f"{cfg.get('city', 'Local')} Weather",
            "sourceNote": agenda.get("sourceNote", ""),
            "today": agenda.get("today", []),
            "upcoming": agenda.get("upcoming", []),
            "forecast": weather.get("days", []),
        }
    )

    # Declarative Front Page layout (portrait 2-column, landscape 3-column, compact 1-column).
    lead = next((a for a in articles if a.get("lead")), articles[0] if articles else None)
    dispatches = [a for a in articles if a is not lead][:3]
    rail_ids = [w["id"] for w in widgets]
    non_quote_rail = [w["id"] for w in widgets if w["kind"] != "quote"]

    portrait_layout = {
        "kind": "row",
        "align": "top",
        "gap": "large",
        "children": [
            _article_column(articles, width="60%"),
            {
                "kind": "column",
                "gap": "medium",
                "width": "40%",
                "children": [{"kind": "widget", "widgetId": wid} for wid in rail_ids],
            },
        ],
    }

    landscape_col1_children: list[dict[str, Any]] = []
    if lead:
        landscape_col1_children.append({"kind": "article", "articleId": lead["id"], "variant": "lead"})
    if any(w["id"] == "quote" for w in widgets):
        if landscape_col1_children:
            landscape_col1_children.append({"kind": "divider"})
        landscape_col1_children.append({"kind": "widget", "widgetId": "quote"})

    landscape_col2_children: list[dict[str, Any]] = [
        {"kind": "text", "text": "DISPATCHES & CURATED READS", "style": "label", "caps": True}
    ]
    for idx, a in enumerate(dispatches):
        landscape_col2_children.append({"kind": "article", "articleId": a["id"], "variant": "dispatch"})
        if idx < len(dispatches) - 1:
            landscape_col2_children.append({"kind": "divider"})

    landscape_layout = {
        "kind": "row",
        "align": "top",
        "gap": "medium",
        "children": [
            {"kind": "column", "gap": "small", "width": "36%", "children": landscape_col1_children},
            {"kind": "column", "gap": "small", "width": "35%", "children": landscape_col2_children},
            {
                "kind": "column",
                "gap": "small",
                "width": "29%",
                "children": [{"kind": "widget", "widgetId": wid} for wid in non_quote_rail[:2]],
            },
        ],
    }

    return {
        "edition": 1,
        "id": ctx["edition_id"],
        "number": ctx["edition_number"],
        "city": cfg.get("city", ""),
        "title": cfg.get("title", "THE GAZETTE"),
        "dateLine": ctx["date_line"],
        "subtitle": ctx["subtitle"],
        "weather": weather.get("short", ""),
        "quote": quote,
        "widgets": widgets,
        "layout": {
            "portrait": portrait_layout,
            "landscape": landscape_layout,
        },
        "tabs": tabs,
    }
