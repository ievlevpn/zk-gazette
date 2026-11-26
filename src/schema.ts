// Gazette Edition JSON schema (edition: 1) — modular, widget-driven daily newspaper.
//
// Any user can compose their own newspaper by generating a single JSON file with:
//   - Masthead metadata (`title`, `dateLine`, `city`, `weather`, `subtitle`)
//   - Optional `widgets` on the Front Page rail (any mix or order of `weather`, `agenda`,
//     `listings`, `facts`, `note`, `quote` — or `[]` for an articles-only broadsheet!)
//   - Customizable `tabs` (`articles`, `listings`, `agenda`, `briefs`)

export interface GazetteArticle {
  id: string;
  title: string;
  kicker?: string;
  source?: string;
  author?: string;
  date?: string;
  url?: string;
  readTime?: string;
  isNew?: boolean;
  lead?: boolean;
  summary?: string;
  whyNote?: string;
  tags?: string[];
  /** Full HTML opened in zk.reader.open Preview mode (scripts stripped by the app). */
  html?: string;
}

export interface GazetteListing {
  id: string;
  title: string;
  when: string;
  venue: string;
  /** Filter chip label (e.g. venue, city, topic). */
  category?: string;
  subtitle?: string;
  meta?: string;
  summary?: string;
  note?: string;
  isNew?: boolean;
  url?: string;
  details?: { label: string; value: string }[];
  /** Optional full HTML program/detail sheet; auto-generated if omitted. */
  html?: string;
}

export interface GazetteAgendaItem {
  time: string;
  title: string;
  place?: string;
  day?: string;
  note?: string;
}

export interface GazetteForecastDay {
  day: string;
  temp: string;
  desc: string;
}

export interface GazetteBrief {
  id: string;
  kicker?: string;
  title: string;
  bullets: string[];
  note?: string;
}

export type GazetteWidget =
  | {
      id: string;
      kind: "agenda";
      title?: string;
      tabId?: string;
      today: GazetteAgendaItem[];
      upcoming?: GazetteAgendaItem[];
      maxToday?: number;
      maxUpcoming?: number;
    }
  | {
      id: string;
      kind: "listings";
      title?: string;
      tabId?: string;
      items: GazetteListing[];
      maxItems?: number;
    }
  | {
      id: string;
      kind: "weather";
      title?: string;
      location?: string;
      current?: string;
      summary?: string;
      days?: GazetteForecastDay[];
    }
  | {
      id: string;
      kind: "facts";
      title?: string;
      tone?: "plain" | "light";
      items: { label: string; value: string; note?: string }[];
    }
  | {
      id: string;
      kind: "note";
      title?: string;
      tone?: "plain" | "light";
      body: string;
      footer?: string;
    }
  | {
      id: string;
      kind: "quote";
      title?: string;
      text: string;
      source?: string;
    }
  | {
      id: string;
      kind: "custom";
      title?: string;
      node: GazetteNode;
    };

export type GazetteTab =
  | {
      id: string;
      title: string;
      kind: "articles";
      heading?: string;
      items: GazetteArticle[];
    }
  | {
      id: string;
      title: string;
      kind: "listings";
      heading?: string;
      railTitle?: string;
      items: GazetteListing[];
    }
  | {
      id: string;
      title: string;
      kind: "agenda";
      todayTitle?: string;
      upcomingTitle?: string;
      forecastTitle?: string;
      sourceNote?: string;
      today: GazetteAgendaItem[];
      upcoming?: GazetteAgendaItem[];
      forecast?: GazetteForecastDay[];
    }
  | {
      id: string;
      title: string;
      kind: "briefs";
      heading?: string;
      items: GazetteBrief[];
    }
  | {
      id: string;
      title: string;
      kind: "custom";
      blocks: GazetteNode[];
    };

export type GazetteNode =
  | { kind: "column"; gap?: zk.ui.Gap; width?: zk.ui.Width; children: GazetteNode[] }
  | { kind: "row"; gap?: zk.ui.Gap; align?: zk.ui.RowAlign; width?: zk.ui.Width; children: GazetteNode[] }
  | {
      kind: "box";
      border?: zk.ui.Border;
      fill?: zk.ui.Fill;
      pad?: zk.ui.Gap;
      radius?: zk.ui.Radius;
      width?: zk.ui.Width;
      openArticle?: string;
      openListing?: string;
      openTab?: string;
      child: GazetteNode;
    }
  | {
      kind: "text";
      text: string;
      style?: zk.ui.TextStyle;
      font?: zk.ui.TextOptions["font"];
      weight?: zk.ui.TextOptions["weight"];
      size?: zk.ui.TextOptions["size"];
      tone?: zk.ui.TextOptions["tone"];
      align?: zk.ui.TextOptions["align"];
      caps?: boolean;
      italic?: boolean;
      lines?: number;
      width?: zk.ui.Width;
      openArticle?: string;
      openListing?: string;
      openTab?: string;
      saveArticle?: string;
    }
  | { kind: "pill"; text: string; width?: zk.ui.Percent; tone?: "ink" | "light" }
  | { kind: "divider" }
  | { kind: "space" }
  | { kind: "spacer" }
  | { kind: "notice"; text: string }
  | { kind: "quote"; text: string; source?: string }
  | { kind: "widget"; widgetId: string }
  | { kind: "article"; articleId: string; variant?: "lead" | "dispatch" };

export interface GazetteEdition {
  edition?: number;
  /** Unique edition stamp (e.g. "2026-11-26"); used to detect fresh editions in background refresh. */
  id: string;
  title: string;
  number?: string;
  city?: string;
  dateLine: string;
  subtitle?: string;
  weather?: string;
  quote?: { text: string; source?: string };
  /**
   * Optional ordered list of Front Page sidebar widgets.
   * - Omit (`undefined`) to auto-compose a sensible rail from `tabs` + `quote`.
   * - Pass `[]` for an articles-only broadsheet with no sidebar!
   */
  widgets?: GazetteWidget[];
  /**
   * Optional server-side Front Page layout template (portrait & optional landscape override).
   * When present, Gazette renders this declarative block tree instead of the built-in Front Page,
   * so users can redecorate their newspaper purely on the server side!
   */
  layout?: {
    portrait?: GazetteNode;
    landscape?: GazetteNode;
    compact?: GazetteNode;
  };
  tabs: GazetteTab[];
}

export function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseWidget(raw: unknown, idx: number): GazetteWidget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;
  const id = typeof w.id === "string" && w.id.trim() ? w.id.trim() : `widget-${idx + 1}`;
  const title = typeof w.title === "string" ? w.title : undefined;
  const tone = w.tone === "light" ? "light" : "plain";
  switch (w.kind) {
    case "agenda":
      return {
        id,
        kind: "agenda",
        title,
        tabId: typeof w.tabId === "string" ? w.tabId : undefined,
        today: Array.isArray(w.today) ? (w.today as GazetteAgendaItem[]) : [],
        upcoming: Array.isArray(w.upcoming) ? (w.upcoming as GazetteAgendaItem[]) : [],
        maxToday: typeof w.maxToday === "number" ? w.maxToday : undefined,
        maxUpcoming: typeof w.maxUpcoming === "number" ? w.maxUpcoming : undefined,
      };
    case "listings":
      return {
        id,
        kind: "listings",
        title,
        tabId: typeof w.tabId === "string" ? w.tabId : undefined,
        items: Array.isArray(w.items) ? (w.items as GazetteListing[]) : [],
        maxItems: typeof w.maxItems === "number" ? w.maxItems : undefined,
      };
    case "weather":
      return {
        id,
        kind: "weather",
        title,
        location: typeof w.location === "string" ? w.location : undefined,
        current: typeof w.current === "string" ? w.current : undefined,
        summary: typeof w.summary === "string" ? w.summary : undefined,
        days: Array.isArray(w.days) ? (w.days as GazetteForecastDay[]) : [],
      };
    case "facts":
      return {
        id,
        kind: "facts",
        title,
        tone,
        items: Array.isArray(w.items)
          ? (w.items as { label: string; value: string; note?: string }[]).filter(
              (x) => x && typeof x.label === "string" && typeof x.value === "string",
            )
          : [],
      };
    case "note":
      if (typeof w.body !== "string") return null;
      return {
        id,
        kind: "note",
        title,
        tone,
        body: w.body,
        footer: typeof w.footer === "string" ? w.footer : undefined,
      };
    case "quote":
      if (typeof w.text !== "string") return null;
      return {
        id,
        kind: "quote",
        title,
        text: w.text,
        source: typeof w.source === "string" ? w.source : undefined,
      };
    case "custom":
      if (!w.node || typeof w.node !== "object" || Array.isArray(w.node)) return null;
      return {
        id,
        kind: "custom",
        title,
        node: w.node as GazetteNode,
      };
    default:
      return null;
  }
}

/** Validates and normalizes an untrusted JSON payload into a GazetteEdition, or throws an Error. */
export function parseEdition(raw: unknown): GazetteEdition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Edition JSON must be an object");
  }
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : "THE GAZETTE";
  const dateLine = typeof o.dateLine === "string" && o.dateLine.trim() ? o.dateLine.trim() : new Date().toISOString().slice(0, 10);
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : `${title}:${dateLine}`;
  if (!Array.isArray(o.tabs) || o.tabs.length === 0) {
    throw new Error("Edition JSON must have a non-empty `tabs` array");
  }
  const tabs: GazetteTab[] = [];
  for (const t of o.tabs) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    const tab = t as Record<string, unknown>;
    const tabId = typeof tab.id === "string" && tab.id.trim() ? tab.id.trim() : `tab-${tabs.length + 1}`;
    const tabTitle = typeof tab.title === "string" && tab.title.trim() ? tab.title.trim() : tabId;
    const kind = tab.kind;
    if (kind === "articles" && Array.isArray(tab.items)) {
      tabs.push({
        id: tabId,
        title: tabTitle,
        kind: "articles",
        heading: typeof tab.heading === "string" ? tab.heading : undefined,
        items: tab.items.filter((x): x is GazetteArticle => Boolean(x && typeof x === "object" && typeof (x as GazetteArticle).title === "string")),
      });
    } else if (kind === "listings" && Array.isArray(tab.items)) {
      tabs.push({
        id: tabId,
        title: tabTitle,
        kind: "listings",
        heading: typeof tab.heading === "string" ? tab.heading : undefined,
        railTitle: typeof tab.railTitle === "string" ? tab.railTitle : undefined,
        items: tab.items.filter((x): x is GazetteListing => Boolean(x && typeof x === "object" && typeof (x as GazetteListing).title === "string")),
      });
    } else if (kind === "agenda") {
      tabs.push({
        id: tabId,
        title: tabTitle,
        kind: "agenda",
        todayTitle: typeof tab.todayTitle === "string" ? tab.todayTitle : undefined,
        upcomingTitle: typeof tab.upcomingTitle === "string" ? tab.upcomingTitle : undefined,
        forecastTitle: typeof tab.forecastTitle === "string" ? tab.forecastTitle : undefined,
        sourceNote: typeof tab.sourceNote === "string" ? tab.sourceNote : undefined,
        today: Array.isArray(tab.today) ? (tab.today as GazetteAgendaItem[]) : [],
        upcoming: Array.isArray(tab.upcoming) ? (tab.upcoming as GazetteAgendaItem[]) : [],
        forecast: Array.isArray(tab.forecast) ? (tab.forecast as GazetteForecastDay[]) : [],
      });
    } else if (kind === "briefs" && Array.isArray(tab.items)) {
      tabs.push({
        id: tabId,
        title: tabTitle,
        kind: "briefs",
        heading: typeof tab.heading === "string" ? tab.heading : undefined,
        items: tab.items as GazetteBrief[],
      });
    } else if (kind === "custom" && Array.isArray(tab.blocks)) {
      tabs.push({
        id: tabId,
        title: tabTitle,
        kind: "custom",
        blocks: tab.blocks.filter((x): x is GazetteNode => Boolean(x && typeof x === "object" && !Array.isArray(x))),
      });
    }
  }
  if (tabs.length === 0) throw new Error("Edition JSON contains no supported tabs");
  const quote =
    o.quote && typeof o.quote === "object" && typeof (o.quote as { text?: unknown }).text === "string"
      ? {
          text: (o.quote as { text: string }).text,
          source: typeof (o.quote as { source?: unknown }).source === "string" ? (o.quote as { source: string }).source : undefined,
        }
      : undefined;
  const widgets = Array.isArray(o.widgets)
    ? o.widgets.map((w, i) => parseWidget(w, i)).filter((w): w is GazetteWidget => w !== null)
    : undefined;
  const rawLayout = o.layout && typeof o.layout === "object" && !Array.isArray(o.layout) ? (o.layout as Record<string, unknown>) : null;
  const layout = rawLayout
    ? {
        portrait: rawLayout.portrait && typeof rawLayout.portrait === "object" ? (rawLayout.portrait as GazetteNode) : undefined,
        landscape: rawLayout.landscape && typeof rawLayout.landscape === "object" ? (rawLayout.landscape as GazetteNode) : undefined,
        compact: rawLayout.compact && typeof rawLayout.compact === "object" ? (rawLayout.compact as GazetteNode) : undefined,
      }
    : undefined;
  return {
    edition: typeof o.edition === "number" ? o.edition : 1,
    id,
    title,
    number: typeof o.number === "string" ? o.number : undefined,
    city: typeof o.city === "string" ? o.city : undefined,
    dateLine,
    subtitle: typeof o.subtitle === "string" ? o.subtitle : undefined,
    weather: typeof o.weather === "string" ? o.weather : undefined,
    quote,
    widgets,
    layout,
    tabs,
  };
}

/** Resolves the Front Page widgets: explicit `edition.widgets` if supplied, else auto-derived from tabs + quote. */
export function resolveWidgets(ed: GazetteEdition): GazetteWidget[] {
  if (ed.widgets !== undefined) return ed.widgets;
  const out: GazetteWidget[] = [];
  const agenda = ed.tabs.find((t): t is Extract<GazetteTab, { kind: "agenda" }> => t.kind === "agenda");
  const listings = ed.tabs.find((t): t is Extract<GazetteTab, { kind: "listings" }> => t.kind === "listings");
  if (agenda) {
    out.push({
      id: `agenda:${agenda.id}`,
      kind: "agenda",
      title: agenda.todayTitle ?? agenda.title,
      tabId: agenda.id,
      today: agenda.today,
      upcoming: agenda.upcoming,
    });
    if ((agenda.forecast?.length ?? 0) > 0 && !listings) {
      out.push({
        id: `weather:${agenda.id}`,
        kind: "weather",
        title: agenda.forecastTitle ?? "Weather",
        location: ed.city,
        current: ed.weather,
        days: agenda.forecast,
      });
    }
  }
  if (listings) {
    out.push({
      id: `listings:${listings.id}`,
      kind: "listings",
      title: listings.railTitle ?? listings.title,
      tabId: listings.id,
      items: listings.items,
    });
  }
  if (ed.quote) {
    out.push({
      id: "quote",
      kind: "quote",
      title: "Epigraph",
      text: ed.quote.text,
      source: ed.quote.source,
    });
  }
  return out;
}

export function widgetLabel(w: GazetteWidget): string {
  if (w.title) return w.title;
  switch (w.kind) {
    case "agenda":
      return "Agenda";
    case "listings":
      return "Watch";
    case "weather":
      return "Weather";
    case "facts":
      return "At a Glance";
    case "note":
      return "Daily Note";
    case "quote":
      return "Epigraph";
    case "custom":
      return "Widget";
  }
}

/** Fallback HTML when an article only provides plain summary/whyNote instead of full HTML. */
export function articleToHtml(a: GazetteArticle): string {
  if (a.html && a.html.trim()) return a.html;
  const meta = [a.author ? `By ${a.author}` : "", a.source ?? "", a.readTime ?? "", a.date ?? ""].filter(Boolean).join(" · ");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Georgia, serif; line-height: 1.55; margin: 0 5%; color: #111; }
  .kicker { font-family: sans-serif; font-size: 0.72em; letter-spacing: 0.14em; text-transform: uppercase; color: #555; margin-top: 1.2em; margin-bottom: 0.4em; }
  h1 { font-size: 1.7em; line-height: 1.18; margin: 0 0 0.45em 0; }
  .byline { font-family: sans-serif; font-size: 0.82em; color: #555; border-bottom: 1px solid #bbb; padding-bottom: 0.8em; margin-bottom: 1.2em; }
  .note { font-style: italic; border-left: 3px solid #222; padding-left: 0.9em; margin-top: 1.2em; color: #333; }
</style>
</head>
<body>
  ${a.kicker ? `<div class="kicker">${escapeHtml(a.kicker)}</div>` : ""}
  <h1>${escapeHtml(a.title)}</h1>
  ${meta ? `<div class="byline">${escapeHtml(meta)}</div>` : ""}
  ${a.summary ? `<p>${escapeHtml(a.summary)}</p>` : ""}
  ${a.whyNote ? `<p class="note">${escapeHtml(a.whyNote)}</p>` : ""}
</body>
</html>`;
}

/** Formats a listing item as a clean printable program / detail sheet for Preview mode. */
export function listingToHtml(c: GazetteListing, sectionTitle: string): string {
  if (c.html && c.html.trim()) return c.html;
  const detailRows = [
    { label: "When", value: c.when },
    { label: "Venue", value: c.venue },
    ...(c.subtitle ? [{ label: "Featured", value: c.subtitle }] : []),
    ...(c.meta ? [{ label: "Details", value: c.meta }] : []),
    ...(c.details ?? []),
  ];
  const cardHtml = detailRows
    .map((d) => `<strong>${escapeHtml(d.label)}:</strong> ${escapeHtml(d.value)}`)
    .join("<br>");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Georgia, serif; line-height: 1.55; margin: 0 5%; color: #111; }
  .kicker { font-family: sans-serif; font-size: 0.72em; letter-spacing: 0.14em; text-transform: uppercase; color: #555; margin-top: 1.2em; margin-bottom: 0.4em; }
  h1 { font-size: 1.7em; line-height: 1.18; margin: 0 0 0.35em 0; }
  .sub { font-family: sans-serif; font-size: 0.9em; color: #444; margin-bottom: 1.1em; padding-bottom: 0.7em; border-bottom: 1px solid #bbb; }
  .card { border: 1px solid #888; background: #f4f4f4; padding: 0.9em 1.1em; margin: 1.1em 0; font-family: sans-serif; font-size: 0.88em; line-height: 1.6; }
  h2 { font-size: 1.1em; margin-top: 1.4em; margin-bottom: 0.4em; font-family: sans-serif; text-transform: uppercase; letter-spacing: 0.08em; }
  .note { font-style: italic; border-left: 3px solid #222; padding-left: 0.9em; margin-top: 1.2em; }
</style>
</head>
<body>
  <div class="kicker">${escapeHtml(sectionTitle)} · ${escapeHtml(c.venue)}${c.isNew ? " · NEW" : ""}</div>
  <h1>${escapeHtml(c.title)}</h1>
  <div class="sub">${escapeHtml(c.when)}${c.subtitle ? ` · ${escapeHtml(c.subtitle)}` : ""}</div>
  <div class="card">${cardHtml}</div>
  ${c.summary ? `<h2>Overview</h2><p>${escapeHtml(c.summary)}</p>` : ""}
  ${c.note ? `<h2>Gazette Note</h2><p class="note">${escapeHtml(c.note)}</p>` : ""}
</body>
</html>`;
}

/** Formats preview highlights/underlines/comments into a clean Zotero HTML child note. */
export function annotationsToNoteHtml(annotations: zk.reader.PreviewAnnotation[], header = "Highlights from Preview"): string {
  const blocks = annotations.map((a) => {
    const loc = a.pageLabel ? ` <span style="color:#666">(${escapeHtml(a.pageLabel)})</span>` : "";
    const tagStr = a.tags && a.tags.length ? ` <span style="color:#666">[${a.tags.map((t) => `#${escapeHtml(t)}`).join(" ")}]</span>` : "";
    const quote = `<blockquote><p>${escapeHtml(a.text)}${loc}${tagStr}</p></blockquote>`;
    const comment = a.comment ? `<p>${escapeHtml(a.comment)}</p>` : "";
    return `${quote}${comment}`;
  });
  return `<h3>${escapeHtml(header)}</h3>\n${blocks.join("\n")}`;
}
