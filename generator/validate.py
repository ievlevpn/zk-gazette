#!/usr/bin/env python3
"""
Standalone validator for Gazette Edition JSON (`edition: 1`).

Zero external dependencies (Python 3 stdlib only). Run directly on any edition file:

    python3 generator/validate.py today.json

Or import `validate_edition(data)` from your own scripts (also run automatically by `generate.py`).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

VALID_TAB_KINDS = {"articles", "listings", "agenda", "briefs", "custom"}
VALID_WIDGET_KINDS = {"agenda", "listings", "weather", "facts", "note", "quote", "custom"}
VALID_NODE_KINDS = {
    "column",
    "row",
    "box",
    "text",
    "pill",
    "divider",
    "space",
    "spacer",
    "notice",
    "quote",
    "widget",
    "article",
}
VALID_GAPS = {"none", "xsmall", "small", "medium", "large"}
VALID_BORDERS = {"none", "thin", "thick"}
VALID_FILLS = {"none", "light", "ink"}
VALID_RADII = {"none", "small", "round"}
VALID_ROW_ALIGN = {"top", "center", "bottom", "stretch"}
VALID_TEXT_ALIGN = {"start", "center", "end"}
VALID_FONTS = {"serif", "sans"}
VALID_WEIGHTS = {"regular", "medium", "bold"}
VALID_SIZES = {"xsmall", "small", "body", "large", "title"}
VALID_TEXT_TONES = {"ink", "secondary"}
VALID_PILL_TONES = {"ink", "light"}
VALID_TEXT_STYLES = {"title", "body", "meta", "label"}
PERCENT_RE = re.compile(r"^(?:100|[1-9][0-9]?)%$")


def _valid_width(val: Any) -> bool:
    return val in ("fill", "auto") or (isinstance(val, str) and bool(PERCENT_RE.match(val)))


def _check_enum(val: Any, allowed: set[str], path: str, errors: list[str]) -> None:
    if val is not None and val not in allowed:
        errors.append(f"{path}: invalid value {val!r} (expected one of {sorted(allowed)})")


def _validate_node(
    node: Any,
    path: str,
    depth: int,
    errors: list[str],
    warnings: list[str],
    article_ids: set[str],
    listing_ids: set[str],
    tab_ids: set[str],
    widget_map: dict[str, dict[str, Any]],
    widget_stack: list[str],
) -> None:
    if not isinstance(node, dict):
        errors.append(f"{path}: node must be an object")
        return
    if depth > 12:
        errors.append(f"{path}: node nesting exceeds maximum depth 12 (plugin will drop deeper nodes)")
        return
    kind = node.get("kind")
    if kind not in VALID_NODE_KINDS:
        errors.append(f"{path}.kind: unknown node kind {kind!r} (expected one of {sorted(VALID_NODE_KINDS)})")
        return

    if "width" in node and not _valid_width(node["width"]):
        errors.append(f"{path}.width: invalid width {node['width']!r} (expected 'fill', 'auto', or '1%'..'100%')")

    for action_key, target_set, label in (
        ("openArticle", article_ids, "article"),
        ("saveArticle", article_ids, "article"),
        ("openListing", listing_ids, "listing"),
        ("openTab", tab_ids, "tab"),
    ):
        target = node.get(action_key)
        if target is not None:
            if not isinstance(target, str) or not target.strip():
                errors.append(f"{path}.{action_key}: must be a non-empty string")
            elif target_set and target not in target_set:
                warnings.append(f"{path}.{action_key}: references unknown {label} id {target!r}")

    if kind == "column":
        _check_enum(node.get("gap"), VALID_GAPS, f"{path}.gap", errors)
        children = node.get("children")
        if not isinstance(children, list):
            errors.append(f"{path}.children: column requires a list of child nodes")
        else:
            for i, child in enumerate(children):
                _validate_node(
                    child,
                    f"{path}.children[{i}]",
                    depth + 1,
                    errors,
                    warnings,
                    article_ids,
                    listing_ids,
                    tab_ids,
                    widget_map,
                    widget_stack,
                )
    elif kind == "row":
        _check_enum(node.get("gap"), VALID_GAPS, f"{path}.gap", errors)
        _check_enum(node.get("align"), VALID_ROW_ALIGN, f"{path}.align", errors)
        children = node.get("children")
        if not isinstance(children, list):
            errors.append(f"{path}.children: row requires a list of child nodes")
        else:
            if len(children) > 12:
                warnings.append(f"{path}.children: row has {len(children)} children (plugin truncates rows to 12)")
            for i, child in enumerate(children):
                _validate_node(
                    child,
                    f"{path}.children[{i}]",
                    depth + 1,
                    errors,
                    warnings,
                    article_ids,
                    listing_ids,
                    tab_ids,
                    widget_map,
                    widget_stack,
                )
    elif kind == "box":
        _check_enum(node.get("border"), VALID_BORDERS, f"{path}.border", errors)
        _check_enum(node.get("fill"), VALID_FILLS, f"{path}.fill", errors)
        _check_enum(node.get("pad"), VALID_GAPS, f"{path}.pad", errors)
        _check_enum(node.get("radius"), VALID_RADII, f"{path}.radius", errors)
        if "child" not in node:
            errors.append(f"{path}.child: box requires a `child` node")
        else:
            _validate_node(
                node["child"],
                f"{path}.child",
                depth + 1,
                errors,
                warnings,
                article_ids,
                listing_ids,
                tab_ids,
                widget_map,
                widget_stack,
            )
    elif kind == "text":
        if not isinstance(node.get("text"), str):
            errors.append(f"{path}.text: text node requires a string `text`")
        _check_enum(node.get("style"), VALID_TEXT_STYLES, f"{path}.style", errors)
        _check_enum(node.get("font"), VALID_FONTS, f"{path}.font", errors)
        _check_enum(node.get("weight"), VALID_WEIGHTS, f"{path}.weight", errors)
        _check_enum(node.get("size"), VALID_SIZES, f"{path}.size", errors)
        _check_enum(node.get("tone"), VALID_TEXT_TONES, f"{path}.tone", errors)
        _check_enum(node.get("align"), VALID_TEXT_ALIGN, f"{path}.align", errors)
        if "lines" in node and (not isinstance(node["lines"], int) or node["lines"] < 1):
            errors.append(f"{path}.lines: must be a positive integer")
    elif kind == "pill":
        if not isinstance(node.get("text"), str) or not node["text"].strip():
            errors.append(f"{path}.text: pill requires a non-empty string `text`")
        _check_enum(node.get("tone"), VALID_PILL_TONES, f"{path}.tone", errors)
        if "width" in node and not (isinstance(node["width"], str) and PERCENT_RE.match(node["width"])):
            errors.append(f"{path}.width: pill width must be a percentage string like '14%'")
    elif kind == "notice":
        if not isinstance(node.get("text"), str):
            errors.append(f"{path}.text: notice requires a string `text`")
    elif kind == "quote":
        if not isinstance(node.get("text"), str):
            errors.append(f"{path}.text: quote requires a string `text`")
    elif kind == "widget":
        wid = node.get("widgetId")
        if not isinstance(wid, str) or not wid.strip():
            errors.append(f"{path}.widgetId: widget node requires a non-empty string `widgetId`")
        elif wid in widget_stack:
            errors.append(f"{path}.widgetId: cyclic widget reference {' -> '.join(widget_stack + [wid])}")
        elif widget_map and wid not in widget_map:
            warnings.append(f"{path}.widgetId: references unknown widget id {wid!r}")
        elif wid in widget_map and widget_map[wid].get("kind") == "custom":
            _validate_node(
                widget_map[wid].get("node"),
                f"{path}(widget:{wid}).node",
                depth + 1,
                errors,
                warnings,
                article_ids,
                listing_ids,
                tab_ids,
                widget_map,
                widget_stack + [wid],
            )
    elif kind == "article":
        aid = node.get("articleId")
        if not isinstance(aid, str) or not aid.strip():
            errors.append(f"{path}.articleId: article node requires a non-empty string `articleId`")
        elif article_ids and aid not in article_ids:
            warnings.append(f"{path}.articleId: references unknown article id {aid!r}")
        variant = node.get("variant")
        if variant is not None and variant not in ("lead", "dispatch"):
            errors.append(f"{path}.variant: expected 'lead' or 'dispatch', got {variant!r}")


def validate_edition(data: Any) -> tuple[list[str], list[str]]:
    """Returns `(errors, warnings)` for a decoded Gazette Edition JSON object."""
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(data, dict):
        return (["Edition root must be a JSON object"], [])

    for req in ("title", "dateLine"):
        if not isinstance(data.get(req), str) or not data[req].strip():
            errors.append(f"top-level `{req}` must be a non-empty string")

    tabs = data.get("tabs")
    if not isinstance(tabs, list) or len(tabs) == 0:
        errors.append("top-level `tabs` must be a non-empty array")
        tabs = []

    if len(tabs) > 4:
        warnings.append(
            f"`tabs` has {len(tabs)} entries; Gazette shows Front Page plus up to 4 tabs in the top bar (extra tabs are hidden)"
        )

    tab_ids: set[str] = set()
    article_ids: set[str] = set()
    listing_ids: set[str] = set()

    # Pass 1: collect IDs and validate tab metadata
    for i, t in enumerate(tabs):
        tp = f"tabs[{i}]"
        if not isinstance(t, dict):
            errors.append(f"{tp}: tab must be an object")
            continue
        tid = t.get("id")
        if not isinstance(tid, str) or not tid.strip():
            errors.append(f"{tp}.id: must be a non-empty string")
        elif tid in tab_ids:
            errors.append(f"{tp}.id: duplicate tab id {tid!r}")
        else:
            tab_ids.add(tid)
        if not isinstance(t.get("title"), str) or not t["title"].strip():
            errors.append(f"{tp}.title: must be a non-empty string")
        kind = t.get("kind")
        if kind not in VALID_TAB_KINDS:
            errors.append(f"{tp}.kind: invalid tab kind {kind!r} (expected one of {sorted(VALID_TAB_KINDS)})")
            continue

        if kind == "articles":
            items = t.get("items")
            if not isinstance(items, list):
                errors.append(f"{tp}.items: articles tab requires an `items` array")
            else:
                for j, a in enumerate(items):
                    if not isinstance(a, dict) or not isinstance(a.get("title"), str):
                        errors.append(f"{tp}.items[{j}]: article requires a string `title`")
                        continue
                    aid = a.get("id")
                    if not isinstance(aid, str) or not aid.strip():
                        errors.append(f"{tp}.items[{j}].id: article requires a non-empty string `id`")
                    elif aid in article_ids:
                        errors.append(f"{tp}.items[{j}].id: duplicate article id {aid!r}")
                    else:
                        article_ids.add(aid)
        elif kind == "listings":
            items = t.get("items")
            if not isinstance(items, list):
                errors.append(f"{tp}.items: listings tab requires an `items` array")
            else:
                for j, item in enumerate(items):
                    if not isinstance(item, dict) or not isinstance(item.get("title"), str):
                        errors.append(f"{tp}.items[{j}]: listing requires a string `title`")
                        continue
                    lid = item.get("id")
                    if not isinstance(lid, str) or not lid.strip():
                        errors.append(f"{tp}.items[{j}].id: listing requires a non-empty string `id`")
                    elif lid in listing_ids:
                        errors.append(f"{tp}.items[{j}].id: duplicate listing id {lid!r}")
                    else:
                        listing_ids.add(lid)
        elif kind == "briefs":
            items = t.get("items")
            if not isinstance(items, list):
                errors.append(f"{tp}.items: briefs tab requires an `items` array")
            else:
                for j, b in enumerate(items):
                    if not isinstance(b, dict) or not isinstance(b.get("title"), str) or not isinstance(b.get("bullets"), list):
                        errors.append(f"{tp}.items[{j}]: brief requires string `title` and array `bullets`")
        elif kind == "agenda":
            if "today" in t and not isinstance(t["today"], list):
                errors.append(f"{tp}.today: must be an array")
            if "upcoming" in t and not isinstance(t["upcoming"], list):
                errors.append(f"{tp}.upcoming: must be an array")
        elif kind == "custom":
            blocks = t.get("blocks")
            if not isinstance(blocks, list) or len(blocks) == 0:
                errors.append(f"{tp}.blocks: custom tab requires a non-empty `blocks` array of GazetteNode objects")
            elif len(blocks) == 1 and isinstance(blocks[0], dict) and blocks[0].get("kind") == "column":
                children = blocks[0].get("children")
                if isinstance(children, list) and len(children) >= 4:
                    warnings.append(
                        f"{tp}.blocks: wraps {len(children)} items inside one top-level `column`; "
                        "put cards directly in `blocks` instead so multi-page e-ink pagination works cleanly"
                    )

    # Pass 2: validate widgets
    widget_map: dict[str, dict[str, Any]] = {}
    widgets = data.get("widgets")
    if widgets is not None:
        if not isinstance(widgets, list):
            errors.append("top-level `widgets` must be an array when present")
            widgets = []
        for i, w in enumerate(widgets):
            wp = f"widgets[{i}]"
            if not isinstance(w, dict):
                errors.append(f"{wp}: widget must be an object")
                continue
            wid = w.get("id")
            if not isinstance(wid, str) or not wid.strip():
                errors.append(f"{wp}.id: must be a non-empty string")
            elif wid in widget_map:
                errors.append(f"{wp}.id: duplicate widget id {wid!r}")
            else:
                widget_map[wid] = w
            kind = w.get("kind")
            if kind not in VALID_WIDGET_KINDS:
                errors.append(f"{wp}.kind: invalid widget kind {kind!r} (expected one of {sorted(VALID_WIDGET_KINDS)})")
                continue
            if kind == "note" and not isinstance(w.get("body"), str):
                errors.append(f"{wp}.body: note widget requires a string `body`")
            elif kind == "quote" and not isinstance(w.get("text"), str):
                errors.append(f"{wp}.text: quote widget requires a string `text`")
            elif kind == "facts" and not isinstance(w.get("items"), list):
                errors.append(f"{wp}.items: facts widget requires an `items` array")
            elif kind == "custom" and not isinstance(w.get("node"), dict):
                errors.append(f"{wp}.node: custom widget requires a GazetteNode object `node`")
            if kind in ("agenda", "listings") and isinstance(w.get("tabId"), str) and w["tabId"] not in tab_ids:
                warnings.append(f"{wp}.tabId: references unknown tab id {w['tabId']!r}")

    # Pass 3: validate custom widget nodes, custom tab blocks, and front-page layout
    if isinstance(widgets, list):
        for i, w in enumerate(widgets):
            if isinstance(w, dict) and w.get("kind") == "custom" and isinstance(w.get("node"), dict):
                wid = str(w.get("id", f"widgets[{i}]"))
                _validate_node(
                    w["node"],
                    f"widgets[{i}].node",
                    1,
                    errors,
                    warnings,
                    article_ids,
                    listing_ids,
                    tab_ids,
                    widget_map,
                    [wid],
                )

    for i, t in enumerate(tabs):
        if isinstance(t, dict) and t.get("kind") == "custom" and isinstance(t.get("blocks"), list):
            for j, blk in enumerate(t["blocks"]):
                _validate_node(
                    blk,
                    f"tabs[{i}].blocks[{j}]",
                    0,
                    errors,
                    warnings,
                    article_ids,
                    listing_ids,
                    tab_ids,
                    widget_map,
                    [],
                )

    layout = data.get("layout")
    if layout is not None:
        if not isinstance(layout, dict):
            errors.append("top-level `layout` must be an object with optional portrait/landscape/compact keys")
        else:
            for key in ("portrait", "landscape", "compact"):
                if key in layout and layout[key] is not None:
                    _validate_node(
                        layout[key],
                        f"layout.{key}",
                        0,
                        errors,
                        warnings,
                        article_ids,
                        listing_ids,
                        tab_ids,
                        widget_map,
                        [],
                    )

    # Size sanity check
    raw_size = len(json.dumps(data, ensure_ascii=False).encode("utf-8"))
    if raw_size > 1_000_000:
        warnings.append(f"edition JSON is {raw_size // 1024} KB (> 1 MB); trimming article HTML keeps Kindle loads snappy")

    return errors, warnings


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print("Usage: python3 validate.py <today.json>", file=sys.stderr)
        return 2
    path = Path(args[0]).expanduser().resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"ERROR: failed to read JSON {path}: {exc}", file=sys.stderr)
        return 1

    errors, warnings = validate_edition(data)
    for w in warnings:
        print(f"[warn] {w}", file=sys.stderr)
    for e in errors:
        print(f"[error] {e}", file=sys.stderr)

    if errors:
        print(f"FAILED: {len(errors)} error(s), {len(warnings)} warning(s) in {path.name}", file=sys.stderr)
        return 1

    tabs = data.get("tabs", [])
    widgets = data.get("widgets", [])
    size_kb = path.stat().st_size // 1024
    print(
        f"OK: {path.name} ({size_kb} KB) — {len(tabs)} tab(s), {len(widgets)} widget(s), {len(warnings)} warning(s)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
