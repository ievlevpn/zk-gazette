#!/usr/bin/env python3
"""
Example drop-in Gazette source: emits a `facts` widget and a `custom` widget.

Copy this file to a name without a leading underscore (e.g. `reading_stats.py`)
to enable it automatically in `generate.py`.
"""

from __future__ import annotations

import datetime as dt
import json
import os


def main() -> None:
    date_str = os.environ.get("GAZETTE_DATE") or dt.date.today().isoformat()
    day_of_year = dt.date.fromisoformat(date_str).timetuple().tm_yday
    pct = round(day_of_year * 100 / 365)

    payload = {
        "widgets": [
            {
                "id": "year-progress",
                "kind": "custom",
                "title": "Almanac",
                "node": {
                    "kind": "box",
                    "border": "thin",
                    "fill": "light",
                    "pad": "medium",
                    "radius": "small",
                    "child": {
                        "kind": "column",
                        "gap": "xsmall",
                        "children": [
                            {"kind": "text", "text": "ALMANAC", "style": "label", "caps": True},
                            {
                                "kind": "row",
                                "align": "center",
                                "gap": "small",
                                "children": [
                                    {"kind": "text", "text": f"Day {day_of_year} of 365", "font": "serif", "weight": "bold", "size": "body"},
                                    {"kind": "pill", "text": f"{pct}%", "width": "24%", "tone": "ink"},
                                ],
                            },
                            {"kind": "text", "text": f"Edition date: {date_str}", "font": "sans", "size": "xsmall", "tone": "secondary"},
                        ],
                    },
                },
            }
        ]
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
