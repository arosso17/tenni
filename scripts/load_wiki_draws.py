"""
Scrape per-event seeded draws from Wikipedia and upsert into player_tournaments.

For each target tournament, queries the Wikipedia search API, fetches the
"Men's/Women's singles" article wikitext, and extracts seed + player pairs
from {{##TeamBracket}} templates (RD1-seedNN / RD1-teamNN). Idempotent.

Usage:
  python scripts/load_wiki_draws.py --upcoming           # all upcoming in DB
  python scripts/load_wiki_draws.py --tid <uuid>          # one tournament
  python scripts/load_wiki_draws.py --year 2026 --all     # every event that year
  python scripts/load_wiki_draws.py --upcoming --dry-run

Output: prints per-tournament summary; upserts unless --dry-run.
"""

import argparse
import os
import re
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
from datetime import date
from pathlib import Path
from urllib.parse import quote

import requests
from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
sb = create_client(URL, KEY)

WIKI_API = "https://en.wikipedia.org/w/api.php"
UA = {"User-Agent": "TenniFantasy/0.1 (alrevs13@gmail.com)"}

# Map our tour -> Wikipedia gender token. Slams sometimes use "Gentlemen's"/"Ladies'"
# for Wimbledon; the search API handles those variations.
GENDER = {"ATP": "Men's", "WTA": "Women's"}

# IOC 3-letter from {{flagicon|XXX}} or {{XXX}}. Wikipedia flag templates vary;
# regex grabs any 3-letter uppercase preceded by | inside braces.
FLAG_RE = re.compile(r"\{\{\s*(?:flag(?:icon|athlete)?|flagIOC|flagICOteam)\s*\|\s*([A-Z]{3})\b", re.I)
# Player link: [[Carlos Alcaraz]] or [[Carlos Alcaraz|Alcaraz]]
LINK_RE = re.compile(r"\[\[([^|\]\n]+?)(?:\|[^\]\n]+?)?\]\]")


def wiki_search(query: str) -> list[str]:
    titles: list[str] = []
    # Search mainspace + Draft namespace (118).
    for ns in (0, 118):
        r = requests.get(
            WIKI_API,
            params={
                "action": "opensearch",
                "search": query,
                "limit": 8,
                "namespace": ns,
                "format": "json",
            },
            headers=UA,
            timeout=30,
        )
        if r.status_code != 200:
            continue
        data = r.json()
        if len(data) > 1:
            titles.extend(data[1])
    return titles


def wiki_parse(title: str) -> str | None:
    r = requests.get(
        WIKI_API,
        params={
            "action": "parse",
            "page": title,
            "prop": "wikitext",
            "format": "json",
            "redirects": 1,
        },
        headers=UA,
        timeout=60,
    )
    if r.status_code != 200:
        return None
    j = r.json()
    return j.get("parse", {}).get("wikitext", {}).get("*")


def find_article(year: int, name: str, tour: str) -> str | None:
    gender = GENDER[tour]
    queries = [
        f"{year} {name} – {gender} singles",
        f"{year} {name} {gender} singles",
        f"{year} {name} singles",
    ]
    seen = set()
    for q in queries:
        for title in wiki_search(q):
            if title in seen:
                continue
            seen.add(title)
            low = title.lower()
            if "singles" not in low:
                continue
            if str(year) not in title:
                continue
            # Doubles & qualifying pages share singles in title sometimes — exclude.
            if "doubles" in low or "qualifying" in low:
                continue
            # Prefer gender match.
            if (tour == "ATP" and ("men" in low or "gentlemen" in low or "boys" not in low and "girls" not in low)):
                return title
            if (tour == "WTA" and ("women" in low or "ladies" in low)):
                return title
        time.sleep(0.5)
    return None


_DISAMBIG_RE = re.compile(r"\s*\([^)]*\)\s*$")


def _strip_disambig(name: str) -> str:
    return _DISAMBIG_RE.sub("", name).strip()


def parse_player(team_param: str) -> tuple[str | None, str | None]:
    """Return (player_name, ioc) from a RD1-teamNN value."""
    if not team_param:
        return None, None
    ioc = None
    m = FLAG_RE.search(team_param)
    if m:
        ioc = m.group(1).upper()
    link = LINK_RE.search(team_param)
    if link:
        return _strip_disambig(link.group(1).strip()) or None, ioc
    # Plain text fallback.
    cleaned = re.sub(r"\{\{[^}]*\}\}", "", team_param)
    cleaned = re.sub(r"<[^>]+>", "", cleaned).strip()
    cleaned = cleaned.strip("'\" ")
    cleaned = _strip_disambig(cleaned)
    return (cleaned or None), ioc


def _mask_inner_pipes(text: str) -> str:
    """Replace `|` inside `{{...}}` and `[[...]]` with NUL so param splitting works."""
    out = []
    depth_brace = 0
    depth_brack = 0
    i = 0
    while i < len(text):
        c = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if c == "{" and nxt == "{":
            depth_brace += 1
            out.append("{{"); i += 2; continue
        if c == "}" and nxt == "}":
            depth_brace = max(0, depth_brace - 1)
            out.append("}}"); i += 2; continue
        if c == "[" and nxt == "[":
            depth_brack += 1
            out.append("[["); i += 2; continue
        if c == "]" and nxt == "]":
            depth_brack = max(0, depth_brack - 1)
            out.append("]]"); i += 2; continue
        # Only mask pipes inside NESTED templates (depth>=2) or wiki links.
        # The outermost {{template|...}} pipes are real param separators.
        if c == "|" and (depth_brace >= 2 or depth_brack >= 1):
            out.append("\x00")
        else:
            out.append(c)
        i += 1
    return "".join(out)


def _find_template_blocks(text: str, name_re: re.Pattern) -> list[tuple[int, int]]:
    """Return [(start, end)] spans for top-level templates matching name_re."""
    spans = []
    i = 0
    while i < len(text) - 1:
        if text[i] == "{" and text[i + 1] == "{":
            # template open at i
            # check name follows
            m = name_re.match(text, i + 2)
            if m:
                # walk to matching }}
                depth = 1
                j = i + 2
                while j < len(text) - 1 and depth > 0:
                    if text[j] == "{" and text[j + 1] == "{":
                        depth += 1
                        j += 2
                    elif text[j] == "}" and text[j + 1] == "}":
                        depth -= 1
                        j += 2
                    else:
                        j += 1
                spans.append((i, j))
                i = j
                continue
        i += 1
    return spans


def _scope_to_main_draw(text: str) -> str:
    """Return only the slice from `==Draw==` (or similar) up to the next top-level
    heading. Excludes the qualifying-draw section that follows."""
    start_re = re.compile(
        r"^==\s*(?:Singles\s+draw|Draw|Main\s+draw|Finals?)\s*==\s*$", re.M | re.I
    )
    end_re = re.compile(r"^==[^=].*?==\s*$", re.M)
    m = start_re.search(text)
    if not m:
        return text  # fallback: scan everything
    rest_start = m.end()
    end_m = end_re.search(text, rest_start)
    return text[m.start() : end_m.start()] if end_m else text[m.start():]


_SEEDS_TPL_RE = re.compile(r"\{\{\s*seeds\s*\|\s*(\d+)\s*(?:\|[^}]*)?\}\}", re.I)


def _extract_seeds_list(wikitext: str) -> list[dict]:
    """Parse ==Seeds== section. Handles two markup styles:
    1. Numbered list: lines starting with `#`
    2. Template style: `{{seeds|N|...}} {{flagicon|XXX}} [[Player]]`
    """
    seeds_re = re.compile(r"^==\s*Seeds\s*==\s*$", re.M | re.I)
    end_re = re.compile(r"^==[^=].*?==\s*$", re.M)
    m = seeds_re.search(wikitext)
    if not m:
        return []
    end_m = end_re.search(wikitext, m.end())
    section = wikitext[m.end() : end_m.start() if end_m else len(wikitext)]
    out: list[dict] = []

    # Template style — line by line, find {{seeds|N|...}} then strip it and parse rest.
    for line in section.splitlines():
        s = line.strip()
        tm = _SEEDS_TPL_RE.search(s)
        if tm:
            seed = int(tm.group(1))
            remainder = (s[: tm.start()] + s[tm.end() :]).strip()
            name, ioc = parse_player(remainder)
            if name:
                out.append({"name": name, "seed": seed, "country": ioc})
            continue
        # Hash-list style fallback.
        if s.startswith("#") and not s.startswith("#*"):
            s2 = s.lstrip("#").strip()
            if not s2:
                continue
            seed = len([x for x in out if x.get("_hash")]) + 1
            # Only number sequentially if no seeds template was used.
            if not any(not x.get("_hash") for x in out):
                name, ioc = parse_player(s2)
                if name:
                    out.append({"name": name, "seed": seed, "country": ioc, "_hash": True})
    # Strip helper key.
    for r in out:
        r.pop("_hash", None)
    return out


def extract_draw(wikitext: str) -> list[dict]:
    """Walk each TeamBracket template independently, return per-player dicts."""
    entries: dict[str, dict] = {}
    # Pre-populate from Seeds section (fills draft articles where bracket isn't built yet).
    for s in _extract_seeds_list(wikitext):
        entries[s["name"]] = s
    scoped = _scope_to_main_draw(wikitext)
    bracket_name_re = re.compile(r"\d+TeamBracket", re.I)
    blocks = _find_template_blocks(scoped, bracket_name_re)
    param_re = re.compile(
        r"\|\s*(RD\d+-(?:seed|team)\d+)\s*=\s*([^|\n]+(?:\n(?!\|)[^|\n]*)*)",
        re.M,
    )

    for start, end in blocks:
        block = scoped[start:end]
        masked = _mask_inner_pipes(block)
        raw: dict[str, str] = {}
        for m in param_re.finditer(masked):
            raw[m.group(1).strip()] = m.group(2).strip().replace("\x00", "|")

        for key, val in raw.items():
            tm = re.match(r"(RD\d+)-team(\d+)", key)
            if not tm:
                continue
            round_, idx = tm.group(1), tm.group(2)
            seed_val = raw.get(f"{round_}-seed{idx}", "").strip()
            seed = int(seed_val) if seed_val.isdigit() else None
            name, ioc = parse_player(val)
            if not name:
                continue
            if name.lower() in ("bye", "tba", "tbd", "?"):
                continue
            if name not in entries:
                entries[name] = {"name": name, "seed": seed, "country": ioc}
            else:
                if seed is not None and entries[name].get("seed") is None:
                    entries[name]["seed"] = seed
                if ioc and not entries[name].get("country"):
                    entries[name]["country"] = ioc
    return list(entries.values())


def list_tournaments(args) -> list[dict]:
    q = (
        sb.table("tournaments")
        .select("id, name, tour, category, start_date, end_date, status")
        .order("start_date", desc=False)
    )
    if args.tid:
        return q.eq("id", args.tid).execute().data or []
    if args.upcoming:
        today = date.today().isoformat()
        return q.gte("start_date", today).limit(200).execute().data or []
    if args.year:
        rows = (
            q.gte("start_date", f"{args.year}-01-01")
            .lte("start_date", f"{args.year}-12-31")
            .limit(500)
            .execute()
            .data
            or []
        )
        return rows
    return []


def upsert_player(name: str, tour: str, country: str | None) -> str | None:
    existing = (
        sb.table("players")
        .select("id")
        .eq("full_name", name)
        .eq("tour", tour)
        .limit(1)
        .execute()
    )
    if existing.data:
        pid = existing.data[0]["id"]
        if country:
            sb.table("players").update({"country": country}).eq("id", pid).execute()
        return pid
    ins = (
        sb.table("players")
        .insert({"full_name": name, "tour": tour, "country": country})
        .execute()
    )
    return ins.data[0]["id"] if ins.data else None


def process(t: dict, dry_run: bool):
    year = int(t["start_date"][:4])
    tour = t["tour"]
    name = t["name"]
    print(f"\n== {name} ({tour} {t['category']} {t['start_date']}) ==")
    title = find_article(year, name, tour)
    if not title:
        print("  no Wikipedia article found")
        return
    print(f"  article: {title}")
    wikitext = wiki_parse(title)
    if not wikitext:
        print("  could not fetch wikitext")
        return
    entries = extract_draw(wikitext)
    if not entries:
        print("  no entries extracted (article may use a non-bracket template)")
        return
    seeded = sum(1 for e in entries if e.get("seed") is not None)
    print(f"  {len(entries)} entries ({seeded} seeded)")

    if dry_run:
        for e in entries[:5]:
            print(f"   - [{e.get('seed') or '-'}] {e['name']} ({e.get('country') or '?'})")
        if len(entries) > 5:
            print(f"   ...+{len(entries) - 5} more")
        return

    for e in entries:
        pid = upsert_player(e["name"], tour, e.get("country"))
        if not pid:
            continue
        sb.table("player_tournaments").upsert(
            {
                "tournament_id": t["id"],
                "player_id": pid,
                "seed": e.get("seed"),
                "status": "entered",
            }
        ).execute()


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--tid", help="single tournament UUID")
    g.add_argument("--upcoming", action="store_true", help="all upcoming events")
    g.add_argument("--year", type=int, help="all events in year")
    ap.add_argument("--all", action="store_true", help="(with --year) include past events too")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    targets = list_tournaments(args)
    if not targets:
        print("no matching tournaments in DB")
        return
    print(f"processing {len(targets)} tournament(s)")
    for t in targets:
        try:
            process(t, args.dry_run)
        except Exception as ex:
            print(f"  ERROR: {ex}")
        time.sleep(0.6)


if __name__ == "__main__":
    main()
