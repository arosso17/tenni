"""
Scrape Wikipedia ATP/WTA tour schedule pages into seed-catalog shape.

Usage:
  python scripts/scrape_wikipedia.py 2026
  python scripts/scrape_wikipedia.py 2025 2026

Output: data/wiki_calendar_<year>.json with shape:
  { "tournaments": [{external_id, name, tour, category, start_date, end_date,
                     surface, players: []}] }

Then run load_wiki.py (or pipe through load_seed.py path) to upsert into Supabase.

Wikipedia-friendly: respects User-Agent guidance, sleeps between requests.
"""

import json
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data"
HEADERS = {"User-Agent": "TenniFantasy/0.1 (alrevs13@gmail.com)"}

_MONTH_NAMES = "January February March April May June July August September October November December".split()
MONTHS: dict[str, int] = {}
for _i, _m in enumerate(_MONTH_NAMES):
    MONTHS[_m] = _i + 1
    MONTHS[_m[:3]] = _i + 1


def fetch(url: str) -> str:
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.text


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def parse_date_range(text: str, year: int) -> tuple[str, str] | None:
    """Parse strings like '19–26 January', '2-9 March', '15 December – 7 January',
    'Dec 29 Jan 5', 'Jan 5 Jan 12'. Returns (start_iso, end_iso)."""
    if not text:
        return None
    t = text.replace("–", "-").replace("—", "-").replace("\xa0", " ").strip()
    t = re.sub(r"\[[^\]]*\]", "", t).strip()

    # WTA-style: two stacked dates joined by separator. "Dec 29 Jan 5" → start Dec 29, end Jan 5.
    m = re.match(rf"({_MO})\s+(\d{{1,2}})\s*[/|\s-]+\s*({_MO})\s+(\d{{1,2}})", t, re.I)
    if m:
        mo1, d1, mo2, d2 = m.group(1), int(m.group(2)), m.group(3), int(m.group(4))
        mn1 = MONTHS.get(mo1.title())
        mn2 = MONTHS.get(mo2.title())
        if mn1 and mn2:
            y1 = year - 1 if mn1 == 12 and mn2 == 1 else year
            y2 = year + 1 if mn2 < mn1 and mn1 != 12 else year
            return (f"{y1:04d}-{mn1:02d}-{d1:02d}", f"{y2:04d}-{mn2:02d}-{d2:02d}")

    # Single "Mmm DD"
    m = re.match(rf"({_MO})\s+(\d{{1,2}})\s*$", t, re.I)
    if m:
        mo, d = m.group(1), int(m.group(2))
        mn = MONTHS.get(mo.title())
        if mn:
            yr = year - 1 if mn == 12 else year
            start = datetime(yr, mn, d)
            end = start + timedelta(days=6)
            return (start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))

    # "DD-DD Month" or "DD Month - DD Month"
    m = re.match(
        r"(\d{1,2})\s*-\s*(\d{1,2})\s+([A-Za-z]+)\.?", t
    )
    if m:
        d1, d2, mo = int(m.group(1)), int(m.group(2)), m.group(3)
        mn = MONTHS.get(mo) or MONTHS.get(mo.title())
        if not mn:
            return None
        return (f"{year:04d}-{mn:02d}-{d1:02d}", f"{year:04d}-{mn:02d}-{d2:02d}")

    m = re.match(
        r"(\d{1,2})\s+([A-Za-z]+)\.?\s*-\s*(\d{1,2})\s+([A-Za-z]+)\.?", t
    )
    if m:
        d1, mo1, d2, mo2 = int(m.group(1)), m.group(2), int(m.group(3)), m.group(4)
        mn1 = MONTHS.get(mo1) or MONTHS.get(mo1.title())
        mn2 = MONTHS.get(mo2) or MONTHS.get(mo2.title())
        if not (mn1 and mn2):
            return None
        y2 = year + 1 if mn2 < mn1 else year
        return (f"{year:04d}-{mn1:02d}-{d1:02d}", f"{y2:04d}-{mn2:02d}-{d2:02d}")

    # Single date "5 January"
    m = re.match(r"(\d{1,2})\s+([A-Za-z]+)\.?", t)
    if m:
        d1, mo = int(m.group(1)), m.group(2)
        mn = MONTHS.get(mo) or MONTHS.get(mo.title())
        if not mn:
            return None
        start = datetime(year, mn, d1)
        end = start + timedelta(days=6)
        return (start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))

    return None


def categorize(text: str, tour: str) -> str | None:
    """Map Wikipedia category text → our category enum."""
    if not text:
        return None
    t = text.lower()
    if "grand slam" in t:
        return "Slam"
    if "finals" in t and ("atp" in t or "wta" in t or "next gen" in t):
        return "Finals"
    if "1000" in t:
        return "1000"
    if "500" in t:
        return "500"
    if "250" in t:
        return "250"
    if "united cup" in t or "team event" in t or "billie jean king cup" in t or "davis cup" in t:
        return "Team"
    return None


_MO = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December"
DATE_CELL_RE = re.compile(rf"^\s*(?:\d{{1,2}}\s+(?:{_MO})|(?:{_MO})\s+\d{{1,2}})", re.I)
CATEGORY_HINT_RE = re.compile(
    r"\b(Grand Slam|ATP Finals|WTA Finals|ATP 1000|ATP 500|ATP 250|"
    r"WTA 1000|WTA 500|WTA 250|Masters 1000)\b",
    re.I,
)
SURFACE_HINT_RE = re.compile(r"\b(Hard|Clay|Grass|Carpet)\b", re.I)


def parse_schedule_table(table, year: int, tour: str) -> list[dict]:
    """Walk Wikipedia tour-schedule tables. Date cells use rowspan; tournament
    info cell starts with name then location then category then surface."""
    out = []
    current_date_text: str | None = None

    for tr in table.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue

        # Update current week date from any cell that looks like one.
        for c in cells:
            txt = c.get_text(" ", strip=True)
            if DATE_CELL_RE.match(txt):
                current_date_text = txt
                break

        if not current_date_text:
            continue

        # Find a tournament-info cell: contains a category hint.
        for c in cells:
            txt = c.get_text(" ", strip=True)
            cat_match = CATEGORY_HINT_RE.search(txt)
            if not cat_match:
                continue
            cat = categorize(cat_match.group(1), tour) or categorize(txt, tour)
            if not cat:
                continue

            # Tournament name = first <a> in cell, fallback first segment.
            link = c.find("a")
            name = (link.get_text(" ", strip=True) if link else txt.split("|")[0]).strip()
            name = re.sub(r"\[[^\]]*\]", "", name).strip()
            if not name:
                continue

            surf_match = SURFACE_HINT_RE.search(txt)
            surface = surf_match.group(1).lower() if surf_match else None

            dates = parse_date_range(current_date_text, year)
            if not dates:
                continue
            start, end = dates

            out.append({
                "external_id": f"wiki-{tour.lower()}-{year}-{slugify(name)}-{start}",
                "name": name,
                "tour": tour,
                "category": cat,
                "start_date": start,
                "end_date": end,
                "surface": surface,
                "players": [],
            })
            break  # one tournament per row segment
    return out


def scrape_year(year: int) -> dict:
    out = {"tournaments": []}
    for tour, slug in [("ATP", "ATP_Tour"), ("WTA", "WTA_Tour")]:
        url = f"https://en.wikipedia.org/wiki/{year}_{slug}"
        print(f"GET {url}")
        html = fetch(url)
        soup = BeautifulSoup(html, "lxml")
        tables = soup.find_all("table", class_=lambda c: c and "wikitable" in c)
        seen_keys = set()
        for table in tables:
            for ev in parse_schedule_table(table, year, tour):
                k = (ev["name"], ev["start_date"])
                if k in seen_keys:
                    continue
                seen_keys.add(k)
                out["tournaments"].append(ev)
        time.sleep(1)  # polite
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: python scripts/scrape_wikipedia.py YEAR [YEAR ...]")
    for arg in sys.argv[1:]:
        year = int(arg)
        catalog = scrape_year(year)
        out_path = OUT_DIR / f"wiki_calendar_{year}.json"
        out_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Wrote {out_path} — {len(catalog['tournaments'])} tournaments")


if __name__ == "__main__":
    main()
