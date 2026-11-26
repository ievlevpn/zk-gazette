// Gazette — Modular daily e-ink newspaper plugin for zotero-for-kindle.
//
// Sources (in priority order):
//   1. Fetched Edition JSON from the configured HTTPS `url` (cached in zk.storage, refreshed hourly)
//   2. Local `edition.json` dropped into Gazette's plugin `data/` folder (read via zk.files — great
//      for private home servers pushing over SSH/USB without exposing personal data publicly!)
//   3. Built-in Sample Edition (so first launch looks great immediately)
//
// Front Page widgets are 100% data-driven (`weather`, `agenda`, `listings`, `facts`, `note`, `quote`),
// can be omitted completely (`widgets: []` → full-width articles broadsheet), and can be toggled on/off
// individually right inside Gazette's Settings screen.

import { SAMPLE_EDITION } from "./sample";
import {
  annotationsToNoteHtml,
  articleToHtml,
  listingToHtml,
  parseEdition,
  resolveWidgets,
  widgetLabel,
  type GazetteArticle,
  type GazetteEdition,
  type GazetteListing,
  type GazetteNode,
  type GazetteTab,
  type GazetteWidget,
} from "./schema";

declare global {
  namespace zk {
    interface Settings {
      /** Optional HTTPS URL serving a Gazette Edition JSON document. */
      url?: string;
      /** Optional masthead override (defaults to the edition's title). */
      title?: string;
      /** Tags applied when explicitly saving an article to Zotero. */
      tags?: string[];
      /** "annotated" (default): ask Save/Discard on Back only when highlighted; "always": always ask. */
      savePrompt?: "annotated" | "always";
    }
  }
}

// ───────────────────────────── Persisted State & Prefs ─────────────────────────────

interface Prefs {
  url: string;
  titleOverride: string;
  tags: string[];
  savePrompt: "annotated" | "always";
  /** Widget IDs the user chose to hide from the Front Page in Settings. */
  hiddenWidgets: string[];
}

interface State {
  tab: string;
  filters: Record<string, string>;
  readIds: string[];
  savedIds: string[];
  cached: GazetteEdition | null;
  fetchedAt: string | null;
  lastSeenEditionId: string | null;
}

const DEFAULT_STATE: State = {
  tab: "front",
  filters: {},
  readIds: [],
  savedIds: [],
  cached: null,
  fetchedAt: null,
  lastSeenEditionId: null,
};

async function loadPrefs(): Promise<Prefs> {
  const stored = await zk.storage.get<Partial<Prefs>>("prefs");
  const fromSettings = zk.settings;
  return {
    url: stored?.url ?? fromSettings.url ?? "",
    titleOverride: stored?.titleOverride ?? fromSettings.title ?? "",
    tags: stored?.tags ?? fromSettings.tags ?? ["gazette"],
    savePrompt: stored?.savePrompt ?? fromSettings.savePrompt ?? "annotated",
    hiddenWidgets: stored?.hiddenWidgets ?? [],
  };
}

async function savePrefs(change: (p: Prefs) => void): Promise<Prefs> {
  const current = await loadPrefs();
  change(current);
  await zk.storage.set("prefs", current);
  return current;
}

async function loadState(): Promise<State> {
  const saved = await zk.storage.get<Partial<State>>("state");
  return { ...DEFAULT_STATE, ...(saved ?? {}) };
}

async function patchState(fn: (s: State) => void): Promise<State> {
  const next = await zk.storage.update<State>("state", (old) => {
    const s: State = { ...DEFAULT_STATE, ...(old ?? {}) };
    fn(s);
    s.readIds = s.readIds.slice(-500);
    s.savedIds = s.savedIds.slice(-500);
    return s;
  });
  return next ?? DEFAULT_STATE;
}

/** Reads `data/edition.json` if dropped locally by a home server / USB script; returns null if absent or invalid. */
async function readLocalEdition(): Promise<GazetteEdition | null> {
  try {
    const text = await zk.files.read("edition.json");
    if (!text) return null;
    return parseEdition(JSON.parse(text));
  } catch (e) {
    console.warn("gazette local edition.json unreadable:", String(e));
    return null;
  }
}

async function resolveEdition(state: State, prefs: Prefs): Promise<{ edition: GazetteEdition; source: "url" | "local" | "sample" }> {
  const applyTitle = (ed: GazetteEdition): GazetteEdition =>
    prefs.titleOverride.trim() ? { ...ed, title: prefs.titleOverride.trim() } : ed;

  if (state.cached && prefs.url.trim()) {
    return { edition: applyTitle(state.cached), source: "url" };
  }
  const local = await readLocalEdition();
  if (local) return { edition: applyTitle(local), source: "local" };
  if (state.cached) return { edition: applyTitle(state.cached), source: "url" };
  return { edition: applyTitle(SAMPLE_EDITION), source: "sample" };
}

// ───────────────────────────── Edition Fetching & Background Refresh ─────────────────────────────

async function fetchEdition(url: string): Promise<{ edition: GazetteEdition; isNew: boolean }> {
  const clean = url.trim();
  if (!clean) throw new Error("Set an Edition JSON URL in Settings first.");
  const res = await zk.fetch(clean, { timeout: 12000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} from edition URL`);
  const parsed = parseEdition(await res.json());
  let isNew = false;
  await patchState((s) => {
    isNew = s.cached?.id !== parsed.id;
    s.cached = parsed;
    s.fetchedAt = new Date().toISOString();
    if (s.tab !== "front" && !parsed.tabs.some((t) => t.id === s.tab)) s.tab = "front";
  });
  return { edition: parsed, isNew };
}

zk.background(async () => {
  const prefs = await loadPrefs();
  const s = await loadState();
  if (prefs.url.trim()) {
    try {
      const { edition, isNew } = await fetchEdition(prefs.url);
      if (isNew || s.lastSeenEditionId !== edition.id) zk.setBadge("New edition");
      zk.ui.refresh();
      return;
    } catch (e) {
      console.warn("gazette background fetch failed:", String(e));
    }
  }
  const local = await readLocalEdition();
  if (local && s.lastSeenEditionId !== local.id) {
    zk.setBadge("New edition");
    zk.ui.refresh();
  }
});

// ───────────────────────────── Zotero Saving (Opt-In Only) ─────────────────────────────

function toCreator(name: string): zk.Creator {
  const trimmed = name.trim();
  const at = trimmed.lastIndexOf(" ");
  return at < 0
    ? { type: "author", name: trimmed }
    : { type: "author", first: trimmed.slice(0, at), last: trimmed.slice(at + 1) };
}

async function saveArticleToZotero(
  article: GazetteArticle,
  prefs: Prefs,
  annotations: zk.reader.PreviewAnnotation[] = [],
): Promise<string> {
  const tags = [...new Set([...prefs.tags, ...(article.tags ?? [])])].filter(Boolean);
  const fields: zk.ItemFields = {
    type: "webpage",
    title: article.title,
    creators: article.author ? [toCreator(article.author)] : undefined,
    date: article.date,
    url: article.url,
    publication: article.source,
    abstract: article.summary,
  };
  const created = await zk.zotero.createItem(fields, { tags });
  if (annotations.length > 0) {
    await zk.zotero.addNote(created.key, annotationsToNoteHtml(annotations, `Highlights · ${article.title}`));
  }
  await patchState((s) => {
    if (!s.savedIds.includes(article.id)) s.savedIds.push(article.id);
    if (!s.readIds.includes(article.id)) s.readIds.push(article.id);
  });
  return annotations.length > 0
    ? `Saved “${short(article.title)}” to Zotero with ${annotations.length} highlight${annotations.length === 1 ? "" : "s"}.`
    : `Saved “${short(article.title)}” to Zotero.`;
}

async function saveListingToZotero(
  listing: GazetteListing,
  prefs: Prefs,
  annotations: zk.reader.PreviewAnnotation[] = [],
): Promise<string> {
  const tags = [...new Set([...prefs.tags, listing.category?.toLowerCase() ?? ""])].filter(Boolean);
  const created = await zk.zotero.createItem(
    {
      type: "webpage",
      title: `${listing.venue} — ${listing.title}`,
      creators: listing.subtitle ? [toCreator(listing.subtitle)] : undefined,
      url: listing.url,
      abstract: [listing.when, listing.meta, listing.summary, listing.note].filter(Boolean).join(" · "),
    },
    { tags },
  );
  if (annotations.length > 0) {
    await zk.zotero.addNote(created.key, annotationsToNoteHtml(annotations, `Notes · ${listing.title}`));
  }
  await patchState((s) => {
    if (!s.savedIds.includes(listing.id)) s.savedIds.push(listing.id);
  });
  return annotations.length > 0
    ? `Saved “${short(listing.title)}” to Zotero with ${annotations.length} highlight${annotations.length === 1 ? "" : "s"}.`
    : `Saved “${short(listing.title)}” to Zotero.`;
}

function short(s: string, max = 46): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ───────────────────────────── UI Primitives & Broadsheet Pieces ─────────────────────────────

type Block = zk.ui.Block;
type Child = zk.ui.Child;

const wideLayout = () => zk.display.width >= 1500;
const landscapeBroadsheet = () => zk.display.landscape && zk.display.width >= 2000;
const label = (text: string) => zk.ui.text(text, { style: "label", caps: true });

function pill(text: string, width: zk.ui.Percent = "14%", tone: "ink" | "light" = "ink"): Block {
  return zk.ui.box(
    zk.ui.text(text, {
      font: "sans",
      size: "xsmall",
      weight: "bold",
      caps: true,
      align: "center",
      lines: 1,
    }),
    {
      fill: tone,
      border: tone === "ink" ? "none" : "thin",
      pad: "xsmall",
      radius: "small",
      width,
    },
  );
}

function segmented(segments: { id: string; text: string }[], selected: string): Block {
  return zk.ui.box(
    zk.ui.row(
      segments.map((s) =>
        zk.ui.box(
          zk.ui.text(s.text, { align: "center", font: "sans", size: "body", weight: "medium", lines: 1 }),
          {
            id: `tab:${s.id}`,
            pad: "small",
            fill: s.id === selected ? "ink" : "none",
          },
        ),
      ),
      { gap: "none" },
    ),
    { border: "thin", radius: "small" },
  );
}

function masthead(ed: GazetteEdition): Block {
  const leftMeta = [ed.number, ed.city].filter(Boolean).join(" · ") || "DAILY EDITION";
  const subLine = [ed.dateLine, ed.subtitle].filter(Boolean).join("  ·  ");
  return zk.ui.column(
    [
      zk.ui.row(
        [
          zk.ui.text(leftMeta, { font: "sans", size: "xsmall", tone: "secondary", caps: true }),
          ed.weather &&
            zk.ui.text(ed.weather, {
              width: "auto",
              font: "sans",
              size: "xsmall",
              tone: "secondary",
              align: "end",
            }),
          zk.ui.text("Settings ›", {
            id: "open-settings",
            width: "auto",
            font: "sans",
            size: "xsmall",
            weight: "medium",
          }),
        ],
        { align: "center", gap: "medium" },
      ),
      zk.ui.text(ed.title, { font: "serif", weight: "bold", size: "title", align: "center" }),
      zk.ui.text(subLine, { font: "serif", italic: true, size: "small", tone: "secondary", align: "center" }),
      zk.ui.divider(),
    ],
    { gap: "xsmall" },
  );
}

function articleActionRow(article: GazetteArticle, state: State): Block {
  const isRead = state.readIds.includes(article.id);
  const isSaved = state.savedIds.includes(article.id);
  return zk.ui.row(
    [
      zk.ui.text(isRead ? "✓ Read · Open again ›" : "Read in Preview ›", {
        id: `read-link:${article.id}`,
        font: "sans",
        size: "small",
        weight: "medium",
        tone: isRead ? "secondary" : "ink",
      }),
      zk.ui.text(isSaved ? "★ Saved" : "☆ Save to Zotero", {
        id: `save:${article.id}`,
        width: "auto",
        font: "sans",
        size: "small",
        weight: isSaved ? "bold" : "regular",
        tone: isSaved ? "ink" : "secondary",
      }),
    ],
    { align: "center", gap: "medium" },
  );
}

function leadBlock(article: GazetteArticle, state: State): Block {
  const byline = [article.source, article.author, article.readTime].filter(Boolean).join(" · ");
  return zk.ui.column(
    [
      zk.ui.box(
        zk.ui.column(
          [
            zk.ui.row(
              [
                zk.ui.text(article.kicker ?? article.source ?? "LEAD", { style: "label", caps: true }),
                article.isNew && pill("NEW", "14%"),
              ],
              { align: "center", gap: "small" },
            ),
            zk.ui.text(article.title, { font: "serif", weight: "bold", size: "large", lines: 3 }),
            byline && zk.ui.text(byline, { font: "sans", size: "small", tone: "secondary", lines: 1 }),
            article.summary && zk.ui.text(article.summary, { font: "serif", size: "body", lines: 4 }),
          ],
          { gap: "xsmall" },
        ),
        { id: `read:${article.id}`, pad: "none" },
      ),
      articleActionRow(article, state),
    ],
    { gap: "small" },
  );
}

function dispatchBlock(article: GazetteArticle, state: State): Block {
  return zk.ui.column(
    [
      zk.ui.box(
        zk.ui.column(
          [
            zk.ui.row(
              [
                zk.ui.text(article.kicker ?? article.source ?? "DISPATCH", { style: "label", caps: true }),
                article.isNew && pill("NEW", "14%"),
                article.readTime &&
                  zk.ui.text(article.readTime, {
                    width: "auto",
                    font: "sans",
                    size: "xsmall",
                    tone: "secondary",
                  }),
              ],
              { align: "center", gap: "small" },
            ),
            zk.ui.text(article.title, { font: "serif", weight: "bold", size: "body", lines: 2 }),
            article.summary &&
              zk.ui.text(article.summary, { font: "serif", size: "small", tone: "secondary", lines: 2 }),
          ],
          { gap: "xsmall" },
        ),
        { id: `read:${article.id}`, pad: "none" },
      ),
      articleActionRow(article, state),
    ],
    { gap: "xsmall" },
  );
}

// ───────────────────────────── Modular Front Page Widgets ─────────────────────────────

function renderWidget(w: GazetteWidget, compact: boolean): Block {
  switch (w.kind) {
    case "agenda": {
      const maxToday = compact ? Math.min(w.maxToday ?? 4, 4) : (w.maxToday ?? 4);
      const maxUp = compact ? 0 : (w.maxUpcoming ?? 3);
      const upcoming = (w.upcoming ?? []).slice(0, maxUp);
      return zk.ui.box(
        zk.ui.column(
          [
            zk.ui.row(
              [
                label(w.title ?? "Today"),
                w.tabId &&
                  zk.ui.text("Full ›", {
                    id: `wjump:${w.id}:${w.tabId}`,
                    width: "auto",
                    font: "sans",
                    size: "small",
                    weight: "medium",
                  }),
              ],
              { align: "center" },
            ),
            ...(w.today.length === 0
              ? [zk.ui.text("Clear schedule today.", { font: "serif", italic: true, size: "small", tone: "secondary" })]
              : w.today.slice(0, maxToday).map((ev) =>
                  zk.ui.row(
                    [
                      zk.ui.text(ev.time, { width: "24%", font: "sans", size: "small", weight: "bold" }),
                      zk.ui.column(
                        [
                          zk.ui.text(ev.title, { font: "sans", size: "small", weight: "medium", lines: 1 }),
                          ev.place &&
                            zk.ui.text(ev.place, { font: "sans", size: "xsmall", tone: "secondary", lines: 1 }),
                        ],
                        { gap: "none" },
                      ),
                    ],
                    { align: "top", gap: "small" },
                  ),
                )),
            upcoming.length > 0 && zk.ui.divider(),
            upcoming.length > 0 && label("Next Up"),
            ...upcoming.map((ev) =>
              zk.ui.row(
                [
                  zk.ui.text((ev.day ?? "").slice(0, 6), {
                    width: "26%",
                    font: "sans",
                    size: "xsmall",
                    tone: "secondary",
                  }),
                  zk.ui.text(`${ev.time} ${ev.title}`, { font: "sans", size: "xsmall", lines: 1 }),
                ],
                { align: "top", gap: "xsmall" },
              ),
            ),
          ],
          { gap: "small" },
        ),
        { border: "thin", pad: "medium", radius: "small" },
      );
    }

    case "listings": {
      const newCount = w.items.filter((c) => c.isNew).length;
      const limit = compact ? Math.min(w.maxItems ?? 2, 2) : (w.maxItems ?? 3);
      const shown = w.items.slice(0, limit);
      return zk.ui.box(
        zk.ui.column(
          [
            zk.ui.row(
              [label(w.title ?? "Watch"), newCount > 0 && pill(`${newCount} NEW`, "28%")],
              { align: "center", gap: "small" },
            ),
            ...(shown.length === 0
              ? [zk.ui.text("No upcoming items.", { font: "serif", italic: true, size: "small", tone: "secondary" })]
              : shown.flatMap((c, idx): Child[] => [
                  zk.ui.box(
                    zk.ui.column(
                      [
                        zk.ui.row(
                          [
                            zk.ui.text(c.when, { font: "sans", size: "xsmall", weight: "bold", tone: "secondary" }),
                            c.isNew &&
                              zk.ui.text("● NEW", { width: "auto", font: "sans", size: "xsmall", weight: "bold" }),
                          ],
                          { align: "center", gap: "small" },
                        ),
                        zk.ui.text(`${c.venue} — ${c.title}`, { font: "serif", weight: "bold", size: "small", lines: 2 }),
                        (c.subtitle || c.meta) &&
                          zk.ui.text([c.subtitle, c.meta].filter(Boolean).join(" · "), {
                            font: "sans",
                            size: "xsmall",
                            tone: "secondary",
                            lines: 1,
                          }),
                      ],
                      { gap: "none" },
                    ),
                    { id: `wlisting:${w.id}:${w.tabId ?? ""}:${c.id}`, pad: "none" },
                  ),
                  idx < shown.length - 1 && zk.ui.divider(),
                ])),
            w.tabId &&
              zk.ui.text(`All ${w.items.length} ›`, {
                id: `wjump:${w.id}:${w.tabId}`,
                align: "end",
                font: "sans",
                size: "small",
                weight: "medium",
              }),
          ],
          { gap: "small" },
        ),
        { fill: "light", border: "thin", pad: "medium", radius: "small" },
      );
    }

    case "weather": {
      const days = (w.days ?? []).slice(0, compact ? 3 : 4);
      return zk.ui.box(
        zk.ui.column(
          [
            label(w.title ?? (w.location ? `Weather · ${w.location}` : "Weather")),
            w.current && zk.ui.text(w.current, { font: "serif", weight: "bold", size: "body", lines: 2 }),
            w.summary && zk.ui.text(w.summary, { font: "sans", size: "xsmall", tone: "secondary", lines: 2 }),
            days.length > 0 && zk.ui.divider(),
            ...days.map((d) =>
              zk.ui.row(
                [
                  zk.ui.text(d.day, { width: "18%", font: "sans", size: "xsmall", weight: "bold" }),
                  zk.ui.text(d.temp, { width: "30%", font: "sans", size: "xsmall" }),
                  zk.ui.text(d.desc, { font: "sans", size: "xsmall", tone: "secondary", lines: 1 }),
                ],
                { align: "center", gap: "xsmall" },
              ),
            ),
          ],
          { gap: "xsmall" },
        ),
        { fill: "light", border: "thin", pad: "medium", radius: "small" },
      );
    }

    case "facts":
      return zk.ui.box(
        zk.ui.column(
          [
            label(w.title ?? "At a Glance"),
            ...w.items.slice(0, compact ? 4 : 6).map((item) =>
              zk.ui.row(
                [
                  zk.ui.column(
                    [
                      zk.ui.text(item.label, { font: "sans", size: "small", weight: "medium", lines: 1 }),
                      item.note &&
                        zk.ui.text(item.note, { font: "sans", size: "xsmall", tone: "secondary", lines: 1 }),
                    ],
                    { gap: "none" },
                  ),
                  zk.ui.text(item.value, { width: "auto", font: "serif", weight: "bold", size: "body" }),
                ],
                { align: "center", gap: "small" },
              ),
            ),
          ],
          { gap: "small" },
        ),
        { fill: w.tone === "light" ? "light" : "none", border: "thin", pad: "medium", radius: "small" },
      );

    case "note":
      return zk.ui.box(
        zk.ui.column(
          [
            w.title && label(w.title),
            zk.ui.text(w.body, { font: "serif", size: "small", lines: compact ? 5 : 8 }),
            w.footer && zk.ui.text(w.footer, { font: "sans", size: "xsmall", tone: "secondary", lines: 1 }),
          ],
          { gap: "xsmall" },
        ),
        { fill: w.tone === "light" ? "light" : "none", border: "thin", pad: "medium", radius: "small" },
      );

    case "quote":
      return zk.ui.quote({ text: w.text, source: w.source });
  }
}

// ───────────────────────────── Server-Side Custom Layout Renderer ─────────────────────────────

function renderCustomNode(
  node: GazetteNode,
  ed: GazetteEdition,
  state: State,
  prefs: Prefs,
  widgetsById: Map<string, GazetteWidget>,
  seq: { n: number },
  compact: boolean,
  depth = 0,
): Child {
  if (!node || typeof node !== "object" || depth > 12) return null;
  const tapId = (o: { openArticle?: string; openListing?: string; openTab?: string; saveArticle?: string }): string | undefined => {
    const tag = `n${++seq.n}`;
    if (o.openArticle) return `nread:${tag}:${o.openArticle}`;
    if (o.openListing) return `nlist:${tag}:${o.openListing}`;
    if (o.openTab) return `njump:${tag}:${o.openTab}`;
    if (o.saveArticle) return `nsave:${tag}:${o.saveArticle}`;
    return undefined;
  };
  switch (node.kind) {
    case "column":
      return zk.ui.column(
        (node.children ?? []).map((c) => renderCustomNode(c, ed, state, prefs, widgetsById, seq, compact, depth + 1)),
        { gap: node.gap, width: node.width },
      );
    case "row":
      return zk.ui.row(
        (node.children ?? []).slice(0, 12).map((c) => renderCustomNode(c, ed, state, prefs, widgetsById, seq, compact, depth + 1)),
        { gap: node.gap, align: node.align, width: node.width },
      );
    case "box": {
      const inner = renderCustomNode(node.child, ed, state, prefs, widgetsById, seq, compact, depth + 1);
      if (!inner) return null;
      return zk.ui.box(inner, {
        border: node.border,
        fill: node.fill,
        pad: node.pad,
        radius: node.radius,
        width: node.width,
        id: tapId(node),
      });
    }
    case "text":
      return zk.ui.text(String(node.text ?? ""), {
        style: node.style,
        font: node.font,
        weight: node.weight,
        size: node.size,
        tone: node.tone,
        align: node.align,
        caps: node.caps,
        italic: node.italic,
        lines: node.lines,
        width: node.width,
        id: tapId(node),
      });
    case "pill":
      return pill(node.text, node.width ?? "14%", node.tone ?? "ink");
    case "divider":
      return zk.ui.divider();
    case "space":
      return zk.ui.space();
    case "spacer":
      return zk.ui.spacer();
    case "notice":
      return zk.ui.notice(node.text);
    case "quote":
      return zk.ui.quote({ text: node.text, source: node.source });
    case "widget": {
      const w = widgetsById.get(node.widgetId);
      if (!w || prefs.hiddenWidgets.includes(w.id)) return null;
      return renderWidget(w, compact);
    }
    case "article": {
      const a = findArticle(ed, node.articleId);
      if (!a) return null;
      return node.variant === "lead" ? leadBlock(a, state) : dispatchBlock(a, state);
    }
    default:
      return null;
  }
}

// ───────────────────────────── Section Renderers ─────────────────────────────

function renderFrontPage(ed: GazetteEdition, state: State, prefs: Prefs): Child[] {
  // Server-side custom layout template (if provided by the edition generator):
  if (ed.layout) {
    const picked = landscapeBroadsheet()
      ? (ed.layout.landscape ?? ed.layout.portrait)
      : wideLayout()
        ? (ed.layout.portrait ?? ed.layout.compact)
        : (ed.layout.compact ?? ed.layout.portrait);
    if (picked) {
      const widgetsById = new Map(resolveWidgets(ed).map((w) => [w.id, w]));
      const rendered = renderCustomNode(picked, ed, state, prefs, widgetsById, { n: 0 }, landscapeBroadsheet());
      if (rendered) return [rendered];
    }
  }
  const articlesTab = ed.tabs.find((t): t is Extract<GazetteTab, { kind: "articles" }> => t.kind === "articles");
  const articles = articlesTab?.items ?? [];
  const lead = articles.find((a) => a.lead) ?? articles[0];
  const dispatches = articles.filter((a) => a !== lead).slice(0, 3);

  const visibleWidgets = resolveWidgets(ed).filter((w) => !prefs.hiddenWidgets.includes(w.id));
  const quoteWidget = visibleWidgets.find((w) => w.kind === "quote");
  const railWidgets = visibleWidgets.filter((w) => !landscapeBroadsheet() || w !== quoteWidget);

  // Pure articles-only broadsheet when the user has no widgets enabled!
  if (visibleWidgets.length === 0) {
    if (wideLayout() && lead && dispatches.length > 0) {
      const col1 = zk.ui.column([leadBlock(lead, state)], { gap: "small", width: "52%" });
      const col2 = zk.ui.column(
        [
          label("Dispatches & Curated Reads"),
          ...dispatches.flatMap((a, idx): Child[] => [
            dispatchBlock(a, state),
            idx < dispatches.length - 1 && zk.ui.divider(),
          ]),
        ],
        { gap: "small", width: "48%" },
      );
      return [zk.ui.row([col1, col2], { align: "top", gap: "large" })];
    }
    return [
      lead && leadBlock(lead, state),
      lead && dispatches.length > 0 && zk.ui.divider(),
      ...dispatches.flatMap((a, idx): Child[] => [
        dispatchBlock(a, state),
        idx < dispatches.length - 1 && zk.ui.divider(),
      ]),
    ];
  }

  if (landscapeBroadsheet() && lead) {
    const col1 = zk.ui.column(
      [
        leadBlock(lead, state),
        quoteWidget && zk.ui.divider(),
        quoteWidget && renderWidget(quoteWidget, true),
      ],
      { gap: "small", width: "36%" },
    );
    const col2 = zk.ui.column(
      [
        label("Dispatches & Curated Reads"),
        ...dispatches.flatMap((a, idx): Child[] => [
          dispatchBlock(a, state),
          idx < dispatches.length - 1 && zk.ui.divider(),
        ]),
      ],
      { gap: "small", width: "35%" },
    );
    const col3 = zk.ui.column(
      railWidgets.slice(0, 2).map((w) => renderWidget(w, true)),
      { gap: "small", width: "29%" },
    );
    return [zk.ui.row([col1, col2, col3], { align: "top", gap: "medium" })];
  }

  const mainColChildren: Child[] = [];
  if (lead) {
    mainColChildren.push(leadBlock(lead, state));
    if (dispatches.length > 0) mainColChildren.push(zk.ui.divider(), label("Dispatches & Curated Reads"));
  }
  for (let i = 0; i < dispatches.length; i++) {
    mainColChildren.push(dispatchBlock(dispatches[i]!, state));
    if (i < dispatches.length - 1) mainColChildren.push(zk.ui.divider());
  }

  if (wideLayout()) {
    const mainCol = zk.ui.column(mainColChildren, { gap: "small", width: "60%" });
    const rail = zk.ui.column(
      visibleWidgets.map((w) => renderWidget(w, false)),
      { gap: "medium", width: "40%" },
    );
    return [zk.ui.row([mainCol, rail], { align: "top", gap: "large" })];
  }

  return [
    lead && leadBlock(lead, state),
    lead && zk.ui.divider(),
    ...visibleWidgets.map((w) => renderWidget(w, false)),
    dispatches.length > 0 && zk.ui.divider(),
    ...dispatches.flatMap((a, idx): Child[] => [
      dispatchBlock(a, state),
      idx < dispatches.length - 1 && zk.ui.divider(),
    ]),
  ];
}

function renderListingsTab(tab: Extract<GazetteTab, { kind: "listings" }>, state: State): Child[] {
  const categories = [...new Set(tab.items.map((i) => i.category).filter((c): c is string => Boolean(c)))];
  const newCount = tab.items.filter((c) => c.isNew).length;
  const active = state.filters[tab.id] ?? "all";
  const chips: { id: string; title: string }[] = [
    { id: "all", title: `All (${tab.items.length})` },
    ...(newCount > 0 ? [{ id: "new", title: `New (${newCount})` }] : []),
    ...categories.slice(0, 5).map((c) => ({ id: c, title: c })),
  ];
  const filtered = tab.items.filter((c) => {
    if (active === "all") return true;
    if (active === "new") return Boolean(c.isNew);
    return c.category === active;
  });

  return [
    zk.ui.row(
      [
        label(tab.heading ?? tab.title),
        zk.ui.text("Tap any item to preview details", {
          width: "auto",
          font: "sans",
          size: "xsmall",
          tone: "secondary",
        }),
      ],
      { align: "center" },
    ),
    chips.length > 1 &&
      zk.ui.chips({
        id: `filter:${tab.id}`,
        select: "one",
        chips,
        selected: [active],
      }),
    ...filtered.map((c) =>
      zk.ui.box(
        zk.ui.column(
          [
            zk.ui.row(
              [
                zk.ui.text(`${c.when}  ·  ${c.venue}`, { font: "sans", size: "small", weight: "bold" }),
                c.isNew && pill("NEW", "10%"),
                c.meta &&
                  zk.ui.text(c.meta, { width: "auto", font: "sans", size: "small", tone: "secondary" }),
              ],
              { align: "center", gap: "small" },
            ),
            zk.ui.text(c.title, { font: "serif", weight: "bold", size: "large", lines: 2 }),
            c.subtitle && zk.ui.text(c.subtitle, { font: "sans", size: "small", tone: "secondary" }),
            c.summary && zk.ui.text(c.summary, { font: "serif", size: "body", lines: 2 }),
            c.note &&
              zk.ui.text(c.note, { font: "serif", italic: true, size: "small", tone: "secondary", lines: 2 }),
          ],
          { gap: "xsmall" },
        ),
        {
          id: `listing:${tab.id}:${c.id}`,
          border: "thin",
          fill: c.isNew ? "light" : "none",
          pad: "medium",
          radius: "small",
        },
      ),
    ),
  ];
}

function renderAgendaTab(tab: Extract<GazetteTab, { kind: "agenda" }>): Child[] {
  const todayCol = zk.ui.column(
    [
      label(tab.todayTitle ?? "Today"),
      ...(tab.today.length === 0
        ? [zk.ui.notice("Nothing scheduled today.")]
        : tab.today.map((ev) =>
            zk.ui.box(
              zk.ui.row(
                [
                  zk.ui.text(ev.time, { width: "18%", font: "sans", size: "body", weight: "bold" }),
                  zk.ui.column(
                    [
                      zk.ui.text(ev.title, { font: "serif", weight: "bold", size: "body" }),
                      ev.place && zk.ui.text(ev.place, { font: "sans", size: "small", tone: "secondary" }),
                      ev.note &&
                        zk.ui.text(ev.note, { font: "serif", italic: true, size: "small", tone: "secondary" }),
                    ],
                    { gap: "xsmall" },
                  ),
                ],
                { align: "top", gap: "medium" },
              ),
              { border: "thin", pad: "medium", radius: "small" },
            ),
          )),
    ],
    { gap: "small", width: wideLayout() ? "56%" : "fill" },
  );

  const sideCol = zk.ui.column(
    [
      (tab.upcoming?.length ?? 0) > 0 &&
        zk.ui.box(
          zk.ui.column(
            [
              label(tab.upcomingTitle ?? "Coming Up"),
              ...(tab.upcoming ?? []).map((ev) =>
                zk.ui.column(
                  [
                    zk.ui.text([ev.day, ev.time].filter(Boolean).join(" · "), {
                      font: "sans",
                      size: "small",
                      weight: "bold",
                    }),
                    zk.ui.text(ev.title, { font: "serif", size: "body", lines: 1 }),
                    ev.place &&
                      zk.ui.text(ev.place, { font: "sans", size: "xsmall", tone: "secondary", lines: 1 }),
                  ],
                  { gap: "none" },
                ),
              ),
            ],
            { gap: "small" },
          ),
          { border: "thin", pad: "medium", radius: "small" },
        ),
      (tab.forecast?.length ?? 0) > 0 &&
        zk.ui.box(
          zk.ui.column(
            [
              label(tab.forecastTitle ?? "Weather"),
              ...(tab.forecast ?? []).map((f) =>
                zk.ui.row(
                  [
                    zk.ui.text(f.day, { width: "16%", font: "sans", size: "small", weight: "bold" }),
                    zk.ui.text(f.temp, { width: "24%", font: "sans", size: "small" }),
                    zk.ui.text(f.desc, { font: "sans", size: "small", tone: "secondary", lines: 1 }),
                  ],
                  { align: "center", gap: "small" },
                ),
              ),
            ],
            { gap: "small" },
          ),
          { fill: "light", border: "thin", pad: "medium", radius: "small" },
        ),
    ],
    { gap: "medium", width: wideLayout() ? "44%" : "fill" },
  );

  return [
    tab.sourceNote && zk.ui.text(tab.sourceNote, { font: "sans", size: "small", tone: "secondary" }),
    ...(wideLayout() ? [zk.ui.row([todayCol, sideCol], { align: "top", gap: "large" })] : [todayCol, sideCol]),
  ];
}

function renderArticlesTab(tab: Extract<GazetteTab, { kind: "articles" }>, state: State): Child[] {
  const active = state.filters[tab.id] ?? "all";
  const unread = tab.items.filter((a) => !state.readIds.includes(a.id)).length;
  const saved = tab.items.filter((a) => state.savedIds.includes(a.id)).length;
  const filtered = tab.items.filter((a) => {
    if (active === "unread") return !state.readIds.includes(a.id);
    if (active === "saved") return state.savedIds.includes(a.id);
    return true;
  });

  return [
    label(tab.heading ?? `${tab.title} · Opens in Preview`),
    zk.ui.chips({
      id: `filter:${tab.id}`,
      select: "one",
      chips: [
        { id: "all", title: `All (${tab.items.length})` },
        { id: "unread", title: `Unread (${unread})` },
        { id: "saved", title: `Saved (${saved})` },
      ],
      selected: [active],
    }),
    filtered.length === 0 &&
      zk.ui.notice(
        active === "saved"
          ? "Nothing saved to Zotero from this edition yet. Highlight in Preview or tap ☆ Save to Zotero."
          : "You have read every piece in this section.",
      ),
    ...filtered.map((a) =>
      zk.ui.box(
        zk.ui.column(
          [
            zk.ui.box(
              zk.ui.column(
                [
                  zk.ui.row(
                    [
                      zk.ui.text(a.kicker ?? a.source ?? "ARTICLE", { style: "label", caps: true }),
                      a.isNew && pill("NEW", "10%"),
                      zk.ui.text([a.source, a.readTime].filter(Boolean).join(" · "), {
                        width: "auto",
                        font: "sans",
                        size: "xsmall",
                        tone: "secondary",
                      }),
                    ],
                    { align: "center", gap: "small" },
                  ),
                  zk.ui.text(a.title, { font: "serif", weight: "bold", size: "large", lines: 2 }),
                  a.summary && zk.ui.text(a.summary, { font: "serif", size: "body", lines: 3 }),
                  a.whyNote &&
                    zk.ui.text(`Why today: ${a.whyNote}`, {
                      font: "serif",
                      italic: true,
                      size: "small",
                      tone: "secondary",
                      lines: 2,
                    }),
                ],
                { gap: "xsmall" },
              ),
              { id: `read:${a.id}`, pad: "none" },
            ),
            zk.ui.divider(),
            articleActionRow(a, state),
          ],
          { gap: "small" },
        ),
        { border: "thin", pad: "medium", radius: "small" },
      ),
    ),
  ];
}

function renderBriefsTab(tab: Extract<GazetteTab, { kind: "briefs" }>): Child[] {
  return [
    label(tab.heading ?? tab.title),
    ...tab.items.map((b) =>
      zk.ui.box(
        zk.ui.column(
          [
            b.kicker && label(b.kicker),
            zk.ui.text(b.title, { font: "serif", weight: "bold", size: "large" }),
            ...b.bullets.map((line) => zk.ui.text(`•  ${line}`, { font: "serif", size: "body" })),
            b.note && zk.ui.text(b.note, { font: "serif", italic: true, size: "small", tone: "secondary" }),
          ],
          { gap: "xsmall" },
        ),
        { border: "thin", pad: "medium", radius: "small" },
      ),
    ),
  ];
}

// ───────────────────────────── Active Preview Tracking ─────────────────────────────

type PreviewTarget =
  | { kind: "article"; article: GazetteArticle }
  | { kind: "listing"; listing: GazetteListing };

let activePreview: PreviewTarget | null = null;
let noticeText: string | null = null;

/** Opens Preview with Save/highlights when supported (app 0.15.4+), falling back gracefully on 0.12–0.15.3. */
async function openPreview(
  doc: { html: string; title: string; baseUrl?: string },
  save: boolean | "prompt",
): Promise<void> {
  try {
    await zk.reader.open({ ...doc, save });
  } catch (err) {
    if (String(err).includes('unknown field "save"')) {
      await zk.reader.open(doc);
    } else {
      throw err;
    }
  }
}

function findArticle(ed: GazetteEdition, id: string): GazetteArticle | undefined {
  for (const t of ed.tabs) {
    if (t.kind === "articles") {
      const hit = t.items.find((a) => a.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

function findListing(ed: GazetteEdition, tabId: string, id: string): { sectionTitle: string; item: GazetteListing } | undefined {
  if (tabId) {
    const tab = ed.tabs.find((t): t is Extract<GazetteTab, { kind: "listings" }> => t.kind === "listings" && t.id === tabId);
    const hit = tab?.items.find((x) => x.id === id);
    if (tab && hit) return { sectionTitle: tab.title, item: hit };
  }
  for (const w of resolveWidgets(ed)) {
    if (w.kind === "listings") {
      const hit = w.items.find((x) => x.id === id);
      if (hit) return { sectionTitle: w.title ?? "Listing", item: hit };
    }
  }
  for (const t of ed.tabs) {
    if (t.kind === "listings") {
      const hit = t.items.find((x) => x.id === id);
      if (hit) return { sectionTitle: t.title, item: hit };
    }
  }
  return undefined;
}

// ───────────────────────────── Main Gazette Screen ─────────────────────────────

zk.screen("front", {
  title: "Today's Edition",
  main: true,
  render: async () => {
    const [state, prefs] = await Promise.all([loadState(), loadPrefs()]);
    const { edition: ed } = await resolveEdition(state, prefs);

    const segments = [
      { id: "front", text: "Front Page" },
      ...ed.tabs.slice(0, 4).map((t) => {
        if (t.kind === "listings") {
          const n = t.items.filter((x) => x.isNew).length;
          return { id: t.id, text: n > 0 ? `${t.title} (${n} new)` : t.title };
        }
        if (t.kind === "articles") return { id: t.id, text: `${t.title} (${t.items.length})` };
        return { id: t.id, text: t.title };
      }),
    ];

    const activeTab = ed.tabs.find((t) => t.id === state.tab);
    let body: Child[];
    if (!activeTab) body = renderFrontPage(ed, state, prefs);
    else if (activeTab.kind === "listings") body = renderListingsTab(activeTab, state);
    else if (activeTab.kind === "agenda") body = renderAgendaTab(activeTab);
    else if (activeTab.kind === "briefs") body = renderBriefsTab(activeTab);
    else body = renderArticlesTab(activeTab, state);

    return zk.ui.column(
      [
        masthead(ed),
        segmented(segments, activeTab ? activeTab.id : "front"),
        ...body,
        noticeText && zk.ui.notice(noticeText),
      ],
      { gap: "medium" },
    );
  },
  onEvent: async (e) => {
    const [state, prefs] = await Promise.all([loadState(), loadPrefs()]);
    const { edition: ed } = await resolveEdition(state, prefs);

    if (e.kind === "open") {
      noticeText = null;
      zk.setBadge(null);
      await patchState((s) => {
        s.lastSeenEditionId = ed.id;
      });
      return;
    }

    if (e.kind === "result") {
      if (typeof e.value === "string") noticeText = e.value;
      return;
    }

    if (e.kind === "reader") {
      const target = activePreview;
      activePreview = null;
      if (!target) return;
      if (e.action === "save") {
        const anns = e.annotations ?? [];
        try {
          noticeText =
            target.kind === "article"
              ? await saveArticleToZotero(target.article, prefs, anns)
              : await saveListingToZotero(target.listing, prefs, anns);
        } catch (err) {
          noticeText = `Couldn't save to Zotero: ${String(err)}`;
        }
      } else if (e.action === "discard") {
        noticeText = "Discarded (not saved to Zotero).";
      }
      return;
    }

    if (e.kind === "chips" && e.id.startsWith("filter:") && e.selected[0]) {
      const tabId = e.id.slice(7);
      const chosen = e.selected[0];
      noticeText = null;
      await patchState((s) => {
        s.filters[tabId] = chosen;
      });
      return;
    }

    if (e.kind !== "tap") return;

    if (e.id === "open-settings") {
      zk.ui.open("settings");
      return;
    }

    if (e.id.startsWith("tab:")) {
      const tabId = e.id.slice(4);
      noticeText = null;
      await patchState((s) => {
        s.tab = tabId;
      });
      return;
    }

    if (e.id.startsWith("wjump:") || e.id.startsWith("njump:")) {
      const parts = e.id.split(":");
      const tabId = parts[parts.length - 1] ?? "front";
      noticeText = null;
      await patchState((s) => {
        s.tab = tabId;
      });
      return;
    }

    if (e.id.startsWith("read:") || e.id.startsWith("read-link:") || e.id.startsWith("nread:")) {
      const id = e.id.startsWith("nread:") ? e.id.split(":").slice(2).join(":") : e.id.slice(e.id.indexOf(":") + 1);
      const article = findArticle(ed, id);
      if (!article) return;
      noticeText = null;
      await patchState((s) => {
        if (!s.readIds.includes(id)) s.readIds.push(id);
      });
      activePreview = { kind: "article", article };
      await openPreview(
        {
          html: articleToHtml(article),
          title: article.title,
          baseUrl: article.url,
        },
        prefs.savePrompt === "always" ? "prompt" : true,
      );
      return;
    }

    if (e.id.startsWith("listing:") || e.id.startsWith("wlisting:") || e.id.startsWith("nlist:")) {
      const parts = e.id.split(":");
      const tabId = e.id.startsWith("wlisting:") ? (parts[2] ?? "") : e.id.startsWith("nlist:") ? "" : (parts[1] ?? "");
      const itemId = e.id.startsWith("wlisting:")
        ? parts.slice(3).join(":")
        : e.id.startsWith("nlist:")
          ? parts.slice(2).join(":")
          : parts.slice(2).join(":");
      const found = findListing(ed, tabId, itemId);
      if (!found) return;
      noticeText = null;
      activePreview = { kind: "listing", listing: found.item };
      await openPreview(
        {
          html: listingToHtml(found.item, found.sectionTitle),
          title: `${found.item.venue} — ${found.item.title}`,
          baseUrl: found.item.url,
        },
        prefs.savePrompt === "always" ? "prompt" : true,
      );
      return;
    }

    if (e.id.startsWith("save:") || e.id.startsWith("nsave:")) {
      const id = e.id.startsWith("nsave:") ? e.id.split(":").slice(2).join(":") : e.id.slice(5);
      const article = findArticle(ed, id);
      if (!article) return;
      try {
        noticeText = await saveArticleToZotero(article, prefs);
      } catch (err) {
        noticeText = `Couldn't save to Zotero: ${String(err)}`;
      }
    }
  },
});

// ───────────────────────────── Settings Screen ─────────────────────────────

interface SettingsDraft {
  url: string;
  titleOverride: string;
  tagsText: string;
  savePrompt: "annotated" | "always";
  shownWidgets: string[];
  allWidgetIds: string[];
}

let settingsDraft: SettingsDraft | null = null;
let settingsStatus: string | null = null;

zk.screen("settings", {
  title: "Gazette Settings",
  render: async () => {
    const [prefs, state] = await Promise.all([loadPrefs(), loadState()]);
    const { edition: ed, source } = await resolveEdition(state, prefs);
    const allWidgets = resolveWidgets(ed);
    if (!settingsDraft) {
      const allIds = allWidgets.map((w) => w.id);
      settingsDraft = {
        url: prefs.url,
        titleOverride: prefs.titleOverride,
        tagsText: prefs.tags.join(", "),
        savePrompt: prefs.savePrompt,
        allWidgetIds: allIds,
        shownWidgets: allIds.filter((id) => !prefs.hiddenWidgets.includes(id)),
      };
    }
    const d = settingsDraft;
    const sourceDesc =
      source === "url"
        ? `Source: Edition URL · “${ed.title}” (${ed.dateLine})`
        : source === "local"
          ? `Source: local data/edition.json · “${ed.title}” (${ed.dateLine})`
          : "Showing built-in Sample Edition. Enter an HTTPS Edition JSON URL below, or drop edition.json into Gazette's data/ folder.";

    return zk.ui.column(
      [
        label("Edition Source"),
        zk.ui.text(sourceDesc, { font: "sans", size: "small", tone: "secondary" }),
        zk.ui.field({ id: "url", label: "Edition JSON URL (https://…)", placeholder: "https://example.com/gazette/today.json", value: d.url }),
        zk.ui.field({ id: "title", label: "Masthead override (optional)", placeholder: "Leave blank to use the edition's title", value: d.titleOverride }),
        zk.ui.field({ id: "tags", label: "Zotero tags when saving (comma-separated)", placeholder: "gazette, reading", value: d.tagsText }),
        allWidgets.length > 0 && label("Front Page Widgets (tap to toggle)"),
        allWidgets.length > 0 &&
          zk.ui.chips({
            id: "widgets",
            select: "many",
            chips: allWidgets.map((w) => ({ id: w.id, title: widgetLabel(w) })),
            selected: d.shownWidgets,
          }),
        label("When closing a previewed article"),
        zk.ui.chips({
          id: "prompt",
          select: "one",
          chips: [
            { id: "annotated", title: "Ask only if highlighted" },
            { id: "always", title: "Always ask Save or Discard" },
          ],
          selected: [d.savePrompt],
        }),
        zk.ui.buttons([
          { id: "save-fetch", title: "Save & Fetch", primary: true },
          { id: "save-only", title: "Save settings" },
          { id: "use-sample", title: "Reset" },
        ]),
        settingsStatus && zk.ui.notice(settingsStatus),
      ],
      { gap: "medium" },
    );
  },
  onEvent: async (e) => {
    if (e.kind === "open") {
      settingsDraft = null;
      settingsStatus = null;
      return;
    }
    if (!settingsDraft) return;
    if (e.kind === "change") {
      if (e.id === "url") settingsDraft.url = e.text;
      if (e.id === "title") settingsDraft.titleOverride = e.text;
      if (e.id === "tags") settingsDraft.tagsText = e.text;
      return;
    }
    if (e.kind === "chips") {
      if (e.id === "prompt" && e.selected[0]) {
        settingsDraft.savePrompt = e.selected[0] === "always" ? "always" : "annotated";
      } else if (e.id === "widgets") {
        settingsDraft.shownWidgets = e.selected;
      }
      return;
    }
    if (e.kind !== "tap") return;

    const persist = async () => {
      const d = settingsDraft!;
      const tags = d.tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const hidden = d.allWidgetIds.filter((id) => !d.shownWidgets.includes(id));
      return savePrefs((p) => {
        p.url = d.url.trim();
        p.titleOverride = d.titleOverride.trim();
        p.tags = tags;
        p.savePrompt = d.savePrompt;
        p.hiddenWidgets = hidden;
      });
    };

    if (e.id === "save-only") {
      await persist();
      zk.ui.close("Settings saved.");
      return;
    }
    if (e.id === "use-sample") {
      await patchState((s) => {
        s.cached = null;
        s.fetchedAt = null;
        s.tab = "front";
      });
      await savePrefs((p) => {
        p.url = "";
        p.hiddenWidgets = [];
      });
      zk.ui.close("Reset edition source & widgets.");
      return;
    }
    if (e.id === "save-fetch") {
      const prefs = await persist();
      if (!prefs.url) {
        zk.ui.close("Saved settings (using local edition.json or sample).");
        return;
      }
      try {
        const { edition } = await fetchEdition(prefs.url);
        zk.ui.close(`Loaded “${edition.title}” (${edition.dateLine}).`);
      } catch (err) {
        settingsStatus = `Fetch failed: ${String(err)}`;
      }
    }
  },
});
