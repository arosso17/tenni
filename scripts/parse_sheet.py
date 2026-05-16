"""
Parse data/sheet_dump/*.json into a normalized catalog seed.

Output: data/seed_catalog.json
{
  "tournaments": [
    {
      "external_id": "2025-paris-atp-1000",
      "name": "Rolex Paris Masters",
      "tour": "ATP",
      "category": "1000",
      "start_date": "2025-10-27",
      "end_date": "2025-11-02",
      "players": [
        {"name": "Jannik Sinner", "seed": 2, "points_earned": 1000.0,
         "tier": "top8", "drafted_by": "Nic"}
      ]
    }
  ],
  "year_long": {
    "ATP": {"Nic": [{"name": "Jannik Sinner", "tier": "1-8"}, ...], ...},
    "WTA": {...}
  },
  "tournament_scoring_observed": {"ATP": {...counts...}, "WTA": {...}}
}

The script is parsing-only — no DB writes. Run loader separately.
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

DUMP_DIR = Path(r"C:\Users\alrev\WebDev\tenni\data\sheet_dump")
OUT = Path(r"C:\Users\alrev\WebDev\tenni\data\seed_catalog.json")

MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}

# Tournament header looks like:
# "Rolex Paris Masters (ATP 1000), October 27 - November 2, 2025"
# "Australian Open (Grand Slam), January 12 - January 26, 2025"
HEADER_RE = re.compile(
    r"^(?P<name>.+?)\s*\((?P<cat>ATP\s+Grand\s+Slam|WTA\s+Grand\s+Slam|ATP\s+Finals|WTA\s+Finals|ATP\s+\d+|WTA\s+\d+|Grand Slam)\)\s*,\s*"
    r"(?P<m1>[A-Za-z]+)\s+(?P<d1>\d+)\s*-\s*(?:(?P<m2>[A-Za-z]+)\s+)?(?P<d2>\d+),\s*(?P<year>\d{4})",
    re.IGNORECASE,
)

TIER_LABELS = {
    "1-8 seed": "top8",
    "9-16 seed": "9-16",
    "1-16 seed": "top16",
    "17-32 seed": "17-32",
    "unseeded": "unseeded",
}

YEAR_LONG_TIERS = {
    "1-8 rank": "1-8",
    "9-16 rank": "9-16",
    "17-32 rank": "17-32",
    "33-50 rank": "33-50",
    "51-100 rank": "51-100",
    "100+ rank": "100+",
}

SEED_SUFFIX_RE = re.compile(r"\s*\((\d+|WC|Q|LL|PR|SE|ALT)\)\s*$", re.IGNORECASE)


def clean_player(raw: str) -> tuple[str, int | None, str | None]:
    """Return (name, seed_int_or_none, status_token_or_none)."""
    if not raw:
        return "", None, None
    name = raw.strip()
    seed = None
    status = None
    m = SEED_SUFFIX_RE.search(name)
    if m:
        token = m.group(1).upper()
        name = SEED_SUFFIX_RE.sub("", name).strip()
        if token.isdigit():
            seed = int(token)
        else:
            status = token
    # Strip any "/Replacement" notation: "Tsitsipas / Hamad Medjedovic (LL)"
    if "/" in name:
        name = name.split("/")[0].strip()
    return name, seed, status


def parse_date(month: str, day: str, year: str) -> str:
    m = MONTHS[month.lower()]
    return f"{int(year):04d}-{m:02d}-{int(day):02d}"


def parse_header(text: str):
    m = HEADER_RE.match(text.strip())
    if not m:
        return None
    cat_raw = re.sub(r"\s+", " ", m.group("cat").upper())
    if cat_raw == "GRAND SLAM":
        tour = None
        category = "Slam"
    elif "GRAND SLAM" in cat_raw:
        tour = "ATP" if cat_raw.startswith("ATP") else "WTA"
        category = "Slam"
    elif "FINALS" in cat_raw:
        tour = "ATP" if cat_raw.startswith("ATP") else "WTA"
        category = "Finals"
    elif cat_raw.startswith("ATP"):
        tour = "ATP"
        category = cat_raw.split()[1]
    elif cat_raw.startswith("WTA"):
        tour = "WTA"
        category = cat_raw.split()[1]
    else:
        tour, category = None, cat_raw

    start = parse_date(m.group("m1"), m.group("d1"), m.group("year"))
    end_month = m.group("m2") or m.group("m1")
    end = parse_date(end_month, m.group("d2"), m.group("year"))
    name = m.group("name").strip()
    return {"name": name, "tour": tour, "category": category, "start": start, "end": end}


SLAM_TOUR_BY_NAME = {
    "australian open": "BOTH",
    "french open": "BOTH",
    "wimbledon": "BOTH",
    "us open": "BOTH",
}


def slug_id(year: str, name: str, tour: str | None, category: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return f"{year}-{base}-{(tour or '').lower()}-{category.lower()}".replace("--", "-")


def find_user_columns(rows: list[list[str]]) -> dict[str, int] | None:
    """Find the row that lists user names in the per-tournament section.
    Returns mapping {user_name: column_index_of_player_name}.
    Player columns are typically 4, 6, 8 with their points in 5, 7, 9.
    """
    for row in rows:
        # Look for a row where columns 4/6/8 (or wherever) hold user names.
        # The "Player/Points" sub-header sits one row below.
        non_empty = [(i, c.strip()) for i, c in enumerate(row) if c and c.strip()]
        if 2 <= len(non_empty) <= 5:
            # Collect candidate user names: short words, no commas/parens/digits
            cands = [
                (i, c) for i, c in non_empty
                if re.fullmatch(r"[A-Za-z][A-Za-z .'-]{0,20}", c)
                and c.lower() not in {"player", "points", "total points", "draft order"}
            ]
            if 2 <= len(cands) <= 5:
                return {name: idx for idx, name in cands}
    return None


def parse_tournament_block(rows: list[list[str]]):
    """Extract one tournament event from rows starting at a header.
    Returns dict + index just past the event, or (None, len(rows)) if malformed.
    """
    # Row 0 is the header (already validated by caller).
    header_text = next((c for c in rows[0] if c and "(" in c), None)
    if not header_text:
        return None, 1
    parsed = parse_header(header_text)
    if not parsed:
        return None, 1

    # Find user columns within the next ~6 rows.
    user_cols = find_user_columns(rows[1:6])
    if not user_cols:
        return None, 1

    # Walk rows, collect picks, until "Total Points" row or next header.
    picks = []
    consumed = 1
    for idx in range(1, len(rows)):
        row = rows[idx]
        first_label = next((c.strip() for c in row if c and c.strip()), "")
        # Stop at next event header.
        if any(c and HEADER_RE.match(c.strip()) for c in row):
            consumed = idx
            break
        # Stop at total row.
        if "total points" in first_label.lower():
            consumed = idx + 1
            break
        # Tier label may appear in any column up to ~4.
        tier_cell = ""
        for c in row[:6]:
            if c and c.strip().lower() in TIER_LABELS:
                tier_cell = c.strip().lower()
                break
        if not tier_cell:
            continue
        tier = TIER_LABELS[tier_cell]
        for user, name_col in user_cols.items():
            if name_col >= len(row):
                continue
            raw_name = row[name_col]
            if not raw_name or not raw_name.strip():
                continue
            points_raw = row[name_col + 1] if name_col + 1 < len(row) else ""
            try:
                points = float(points_raw) if points_raw else 0.0
            except ValueError:
                points = 0.0
            name, seed, status = clean_player(raw_name)
            if not name:
                continue
            picks.append({
                "name": name,
                "seed": seed,
                "status": status,
                "points_earned": points,
                "tier": tier,
                "drafted_by": user,
            })

    # Determine tour for Slams using event name.
    tour = parsed["tour"]
    if tour is None:
        tour = "BOTH" if SLAM_TOUR_BY_NAME.get(parsed["name"].lower()) else None

    year = parsed["start"][:4]
    return {
        "external_id": slug_id(year, parsed["name"], tour, parsed["category"]),
        "name": parsed["name"],
        "tour": tour,
        "category": parsed["category"],
        "start_date": parsed["start"],
        "end_date": parsed["end"],
        "players": picks,
    }, consumed


def parse_year_long(rows: list[list[str]]):
    """Parse 'ATP Year-Long' or 'WTA Year-Long' tab.
    Returns {user: [{name, tier, points}, ...]}.
    """
    user_cols = find_user_columns(rows[:6])
    if not user_cols:
        return {}
    out: dict[str, list] = {u: [] for u in user_cols}
    for row in rows:
        tier_cell = ""
        for c in row[:6]:
            if c and c.strip().lower() in YEAR_LONG_TIERS:
                tier_cell = c.strip().lower()
                break
        if not tier_cell:
            continue
        tier = YEAR_LONG_TIERS[tier_cell]
        for user, name_col in user_cols.items():
            if name_col >= len(row):
                continue
            raw = row[name_col]
            if not raw or not raw.strip():
                continue
            pts_raw = row[name_col + 1] if name_col + 1 < len(row) else ""
            try:
                pts = float(pts_raw) if pts_raw else 0.0
            except ValueError:
                pts = 0.0
            name, seed, status = clean_player(raw)
            if not name:
                continue
            out[user].append({"name": name, "tier": tier, "season_points": pts})
    return out


def main():
    if not DUMP_DIR.exists():
        sys.exit(f"missing {DUMP_DIR}")

    tournaments = []
    year_long: dict[str, dict] = {}
    skipped: list[str] = []

    for tab_file in sorted(DUMP_DIR.glob("*.json")):
        rows = json.loads(tab_file.read_text())
        tab_name = tab_file.stem

        if tab_name == "ATP_Year-Long":
            year_long["ATP"] = parse_year_long(rows)
            continue
        if tab_name == "WTA_Year-Long":
            year_long["WTA"] = parse_year_long(rows)
            continue
        if tab_name == "Tournament_Scoring":
            continue

        # Find each tournament header in this tab.
        idx = 0
        while idx < len(rows):
            row = rows[idx]
            if any(c and HEADER_RE.match(c.strip()) for c in row):
                event, consumed = parse_tournament_block(rows[idx:])
                if event:
                    tournaments.append(event)
                idx += max(consumed, 1)
            else:
                idx += 1
        if not any(any(c and HEADER_RE.match(c.strip()) for c in r) for r in rows):
            skipped.append(tab_name)

    out = {
        "tournaments": tournaments,
        "year_long": year_long,
        "skipped_tabs": skipped,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"Parsed {len(tournaments)} tournaments")
    print(f"Year-long users: ATP={list(year_long.get('ATP', {}).keys())} "
          f"WTA={list(year_long.get('WTA', {}).keys())}")
    if skipped:
        print(f"Skipped tabs (no headers): {skipped}")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
