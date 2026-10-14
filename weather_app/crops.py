"""El Niño and crops: growing-region rainfall, world prices and crop calendars.

Sources (free, no key):
* NASA POWER (agroclimatology): rainfall in each main growing region, the last
  12 months against the long-term monthly average.
  https://power.larc.nasa.gov/
* IMF Primary Commodity Prices via FRED (St. Louis Fed): monthly world prices.
  https://fred.stlouisfed.org/

The crop notes are the usual El Niño tendencies reported by FAO, USDA, national
agriculture and weather agencies and research (e.g. Iizumi et al. 2014,
"Impacts of El Niño Southern Oscillation on the global yields of major crops").
Every event differs, so the wording says "often" / "tends to".
"""

from __future__ import annotations

import calendar
import csv
import datetime as dt
import io
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from . import services

log = logging.getLogger(__name__)

POWER_CLIMATOLOGY_URL = "https://power.larc.nasa.gov/api/temporal/climatology/point"
POWER_DAILY_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"
PRICE_START_YEAR = 1990
FETCH_WORKERS = 6
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

# Crop id -> display info, keywords (several languages) and the IMF world price on FRED.
CROPS: dict[str, dict[str, Any]] = {
    "rice": {"name": "Rice", "icon": "🌾",
             "keywords": ["rice", "paddy", "arroz", "beras", "padi", "gabah", "riz", "米", "चावल", "धान", "lúa", "gạo", "ข้าว"],
             "price": {"series": "PRICENPQUSDM", "unit": "US$ per tonne", "label": "Rice (Thai 5% broken)"}},
    "wheat": {"name": "Wheat", "icon": "🌾",
              "keywords": ["wheat", "trigo", "gandum", "blé", "小麦", "गेहूं", "गेहूँ"],
              "price": {"series": "PWHEAMTUSDM", "unit": "US$ per tonne", "label": "Wheat"}},
    "maize": {"name": "Maize (corn)", "icon": "🌽",
              "keywords": ["maize", "corn", "maíz", "milho", "jagung", "maïs", "トウモロコシ", "मक्का"],
              "price": {"series": "PMAIZMTUSDM", "unit": "US$ per tonne", "label": "Maize"}},
    "sugar": {"name": "Sugar & sugarcane", "icon": "🍬",
              "keywords": ["sugar", "sugarcane", "cane", "azúcar", "caña", "açúcar", "cana", "gula", "tebu", "sucre",
                           "砂糖", "चीनी", "गन्ना", "đường", "mía", "น้ำตาล"],
              "price": {"series": "PSUGAISAUSDM", "unit": "US cents per pound", "label": "Sugar No. 11 (world)"}},
    "soybeans": {"name": "Soybeans", "icon": "🫘",
                 "keywords": ["soybean", "soybeans", "soy", "soja", "kedelai", "大豆", "सोयाबीन"],
                 "price": {"series": "PSOYBUSDM", "unit": "US$ per tonne", "label": "Soybeans"}},
    "coffee": {"name": "Coffee", "icon": "☕",
               "keywords": ["coffee", "café", "cafe", "kopi", "コーヒー", "कॉफी", "cà phê"],
               "price": {"series": "PCOFFOTMUSDM", "unit": "US cents per pound", "label": "Coffee (other mild arabica)"}},
    "cocoa": {"name": "Cocoa", "icon": "🍫",
              "keywords": ["cocoa", "cacao", "cacau", "kakao", "chocolate", "カカオ"],
              "price": {"series": "PCOCOUSDM", "unit": "US$ per tonne", "label": "Cocoa"}},
    "palm-oil": {"name": "Palm oil", "icon": "🌴",
                 "keywords": ["palm oil", "palm-oil", "aceite de palma", "óleo de palma", "minyak sawit", "sawit", "CPO"],
                 "price": {"series": "PPOILUSDM", "unit": "US$ per tonne", "label": "Palm oil"}},
    "cotton": {"name": "Cotton", "icon": "🧵",
               "keywords": ["cotton", "algodón", "algodão", "kapas", "coton", "綿花", "कपास"],
               "price": {"series": "PCOTTINDUSDM", "unit": "US cents per pound", "label": "Cotton"}},
}

# Effect of a typical El Niño on the crop in that region.
OUTLOOKS = {
    "risk": {"label": "Higher risk", "icon": "▼", "color": "#d9822b"},
    "mixed": {"label": "Mixed", "icon": "◆", "color": "#9b6ad6"},
    "benefit": {"label": "Often benefits", "icon": "▲", "color": "#2f9e6e"},
}


def _r(country, crop, region, lat, lon, season, outlook, note):
    return {"id": f"{country}-{crop}", "country": country, "crop": crop, "region": region,
            "lat": lat, "lon": lon, "season": season, "outlook": outlook, "note": note}


# Main El Niño-sensitive crops by country; lat/lon is a point in the main growing region.
REGIONS: list[dict[str, Any]] = [
    _r("india", "rice", "Central & eastern India (kharif)", 21.5, 82.0, "Sown June–July, harvested October–November", "risk",
       "Kharif rice depends on the June–September monsoon, which El Niño often weakens. Late or patchy rain delays sowing and can cut yields."),
    _r("india", "sugar", "Maharashtra & Karnataka", 18.5, 75.5, "Cane grows over 12–18 months; crushing October–April", "risk",
       "Weak monsoon rain lowers reservoir levels and cane yields, which can shrink the next season's sugar output and exports."),
    _r("india", "soybeans", "Madhya Pradesh", 23.0, 77.0, "Sown June–July", "risk",
       "Rain-fed soybeans are sensitive to dry spells in July–August."),
    _r("india", "cotton", "Gujarat & Maharashtra", 21.0, 75.5, "Sown June–July, picked October–January", "risk",
       "Largely rain-fed; a weak monsoon can reduce yields."),
    _r("india", "wheat", "Punjab, Haryana & Uttar Pradesh (rabi)", 29.5, 76.0, "Sown November, harvested March–April", "mixed",
       "Mostly irrigated, but low reservoirs after a weak monsoon and early spring heat can hurt yields."),
    _r("pakistan", "cotton", "Punjab & Sindh", 30.0, 72.0, "Sown April–June", "risk",
       "Heat and weaker monsoon rain in El Niño years can stress cotton and rice."),
    _r("indonesia", "rice", "Java", -7.2, 110.5, "Main crop sown November–December", "risk",
       "A longer dry season delays planting of the main wet-season crop and cuts dry-season harvests."),
    _r("indonesia", "palm-oil", "Riau & Sumatra", 0.5, 101.5, "Year-round; yields respond to rain 6–24 months earlier", "risk",
       "Drought reduces oil palm yields with a delay of several months to two years, tightening world vegetable oil supply."),
    _r("indonesia", "coffee", "Southern Sumatra (Lampung)", -5.0, 104.5, "Harvest April–August", "risk",
       "Dry conditions during flowering can lower robusta output."),
    _r("indonesia", "cocoa", "Sulawesi", -2.5, 120.5, "Main harvest April–August", "risk",
       "Drought stress reduces pod setting."),
    _r("malaysia", "palm-oil", "Peninsular Malaysia", 3.5, 102.5, "Year-round; yields lag rainfall by months", "risk",
       "Dry spells lower yields several months later, as seen after strong El Niño events."),
    _r("thailand", "rice", "Central & northeast Thailand", 15.5, 102.0, "Main crop sown May–July", "risk",
       "A weak rainy season and low dam levels reduce planting and irrigation for rice."),
    _r("thailand", "sugar", "Northeast & central Thailand", 15.8, 101.5, "Crushing December–April", "risk",
       "Drought cuts cane yields; Thailand is a top sugar exporter, so world prices can react."),
    _r("vietnam", "rice", "Mekong Delta", 10.0, 105.8, "Winter–spring crop December–April", "risk",
       "Drought and saltwater intrusion in the Mekong Delta can damage rice in the dry season."),
    _r("vietnam", "coffee", "Central Highlands", 12.7, 108.1, "Harvest October–January", "risk",
       "The world's largest robusta region: drought during the dry season affects flowering and the next crop."),
    _r("philippines", "rice", "Central Luzon", 15.6, 121.0, "Dry-season crop November–April", "risk",
       "Drought from late in the year into spring often cuts rice and corn output."),
    _r("philippines", "maize", "Mindanao", 7.5, 125.0, "Two crops a year", "risk",
       "Rain-fed corn is hit by El Niño dry spells."),
    _r("australia", "wheat", "Eastern wheat belt (NSW & Victoria)", -33.5, 147.0, "Sown April–June, harvested October–December", "risk",
       "Below-average winter–spring rain in eastern Australia often lowers wheat and barley yields."),
    _r("australia", "sugar", "Queensland", -19.5, 147.3, "Crushing June–November", "mixed",
       "Drier conditions can cut cane growth but help harvesting."),
    _r("china", "rice", "Yangtze basin", 30.5, 114.3, "Summer crop May–September", "mixed",
       "Summers after strong El Niño events have brought Yangtze floods; effects vary by region and year."),
    _r("brazil", "soybeans", "Mato Grosso & southern Brazil", -13.0, -56.0, "Sown September–December", "mixed",
       "Southern Brazil tends to be wetter (often good for soybeans), while irregular rain can delay planting in the centre-west."),
    _r("brazil", "sugar", "São Paulo (centre-south)", -21.5, -48.5, "Crushing April–November", "mixed",
       "Rain during the crush slows harvesting; overall effects vary by event."),
    _r("brazil", "coffee", "Minas Gerais", -20.5, -45.5, "Harvest May–September", "mixed",
       "Heat and irregular rain at flowering (September–October) can affect the next arabica crop."),
    _r("argentina", "soybeans", "Pampas", -34.0, -61.5, "Sown October–December", "benefit",
       "El Niño usually brings more spring–summer rain to the Pampas, often lifting soybean and maize yields."),
    _r("argentina", "maize", "Pampas", -34.0, -61.5, "Sown September–December", "benefit",
       "Wetter conditions tend to support maize, though floods can damage fields."),
    _r("argentina", "wheat", "Pampas", -35.0, -62.0, "Sown May–July, harvested November–December", "benefit",
       "Better spring rain often helps wheat."),
    _r("uruguay", "soybeans", "Western Uruguay", -33.0, -57.5, "Sown October–December", "benefit",
       "Above-normal rain often supports summer crops."),
    _r("colombia", "coffee", "Coffee axis (Caldas & Antioquia)", 5.0, -75.6, "Main harvest September–December", "risk",
       "Drier, hotter weather can reduce coffee yields and quality and increase pests."),
    _r("ecuador", "cocoa", "Coastal lowlands (Los Ríos)", -1.5, -79.5, "Main harvest March–June", "risk",
       "Heavy coastal rain and floods damage cocoa and bananas and spread fungal disease."),
    _r("guatemala", "maize", "Dry Corridor", 14.8, -89.8, "First crop May–August", "risk",
       "Drought in the Central American Dry Corridor causes maize and bean losses for small farmers."),
    _r("honduras", "coffee", "Western highlands", 14.8, -88.5, "Harvest November–March", "risk",
       "Rainfall deficits stress coffee and staple crops."),
    _r("mexico", "maize", "Central & western Mexico", 20.5, -103.0, "Spring–summer crop June–October", "risk",
       "A drier summer rainy season can reduce rain-fed maize."),
    _r("united-states", "wheat", "Southern Plains", 36.0, -98.5, "Winter wheat sown September–November", "benefit",
       "Wetter winters across the southern US often help winter wheat."),
    _r("united-states", "maize", "Corn Belt", 41.5, -93.5, "Sown April–May, harvested September–November", "mixed",
       "El Niño summers are often neutral to favourable for the Corn Belt, but the link is weak."),
    _r("south-africa", "maize", "Free State & North West", -28.0, 27.0, "Sown October–December, harvested May–July", "risk",
       "Below-normal summer rain often lowers maize harvests, as in 2015–16."),
    _r("south-africa", "sugar", "KwaZulu-Natal", -29.0, 31.0, "Crushing April–December", "risk",
       "Drought reduces cane yields."),
    _r("zimbabwe", "maize", "Mashonaland", -17.5, 31.0, "Sown November–December", "risk",
       "El Niño droughts have caused severe maize failures, as in 2015–16 and 2024."),
    _r("zambia", "maize", "Central & southern Zambia", -15.0, 28.0, "Sown November–December", "risk",
       "Drought cuts the maize harvest, the main staple; 2024 was declared a national disaster."),
    _r("malawi", "maize", "Central & southern Malawi", -14.0, 34.0, "Sown November–December", "risk",
       "El Niño tends to bring drought in the south and poor maize harvests."),
    _r("kenya", "maize", "Rift Valley", 0.5, 35.3, "Short-rains crop October–February", "mixed",
       "Wetter short rains can help crops but floods damage fields and stores."),
    _r("ethiopia", "maize", "Central highlands", 8.5, 38.5, "Main (meher) season June–September", "risk",
       "Weaker kiremt rains in El Niño years have caused drought and food shortages, as in 2015."),
]

REGION_BY_ID = {r["id"]: r for r in REGIONS}

_CROP_PATTERNS = {
    cid: re.compile("|".join(rf"\b{re.escape(w)}\b" if w.isascii() else re.escape(w) for w in c["keywords"]), re.IGNORECASE)
    for cid, c in CROPS.items()
}


def detect_crops(text: str) -> list[str]:
    return [cid for cid, pattern in _CROP_PATTERNS.items() if pattern.search(text)]


# --------------------------------------------------------------------------
# Rainfall in growing regions (NASA POWER)
# --------------------------------------------------------------------------

def _valid(v: Any) -> bool:
    return isinstance(v, (int, float)) and v > -900  # POWER uses -999 for missing


def parse_climatology(data: dict[str, Any]) -> list[float | None]:
    """Long-term mean monthly rainfall in mm/month (POWER gives mm/day)."""
    p = data["properties"]["parameter"]["PRECTOTCORR"]
    out = []
    for i, m in enumerate(MONTHS):
        v = p.get(m)
        days = calendar.monthrange(2001, i + 1)[1]  # non-leap year
        out.append(round(v * days, 1) if _valid(v) else None)
    return out


def monthly_totals(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Sum POWER daily rainfall (mm/day) into complete calendar months."""
    p = data["properties"]["parameter"]["PRECTOTCORR"]
    months: dict[str, dict[str, Any]] = {}
    for day, v in sorted(p.items()):
        key = f"{day[:4]}-{day[4:6]}"
        m = months.setdefault(key, {"total": 0.0, "days": 0})
        if _valid(v):
            m["total"] += v
            m["days"] += 1
    rows = []
    for key, m in months.items():
        year, month = int(key[:4]), int(key[5:])
        if m["days"] >= calendar.monthrange(year, month)[1] - 2:  # allow 2 missing days
            rows.append({"month": key, "rain": round(m["total"], 1)})
    return rows


def rain_summary(clim: list[float | None], recent: list[dict[str, Any]]) -> dict[str, Any]:
    months = recent[-12:]
    for m in months:
        normal = clim[int(m["month"][5:]) - 1]
        m["normal"] = normal
        m["pct"] = round(100 * m["rain"] / normal) if normal else None
    last3 = months[-3:]
    total, normal = sum(m["rain"] for m in last3), sum(m["normal"] or 0 for m in last3)
    return {
        "months": months,
        "last3_pct": round(100 * total / normal) if normal else None,
        "last3_label": f"{last3[0]['month']} to {last3[-1]['month']}" if last3 else None,
    }


def fetch_rain(region: dict[str, Any], today: dt.date | None = None) -> dict[str, Any]:
    today = today or dt.datetime.now(dt.timezone.utc).date()
    point = {"parameters": "PRECTOTCORR", "community": "AG", "latitude": region["lat"],
             "longitude": region["lon"], "format": "JSON"}
    clim = parse_climatology(services._get_json(POWER_CLIMATOLOGY_URL, point))
    start = (today.replace(day=1) - dt.timedelta(days=400)).replace(day=1)
    daily = services._get_json(POWER_DAILY_URL, {**point, "start": start.strftime("%Y%m%d"),
                                                 "end": today.strftime("%Y%m%d")})
    return rain_summary(clim, monthly_totals(daily))


# --------------------------------------------------------------------------
# World prices (IMF via FRED)
# --------------------------------------------------------------------------

def parse_fred_csv(text: str, start_year: int = PRICE_START_YEAR) -> list[list[Any]]:
    rows = []
    reader = csv.reader(io.StringIO(text))
    next(reader, None)  # header: observation_date (or DATE), SERIES_ID
    for row in reader:
        if len(row) < 2:
            continue
        date, value = row[0].strip(), row[1].strip()
        if not re.match(r"^\d{4}-\d{2}", date) or int(date[:4]) < start_year:
            continue
        try:
            rows.append([date[:7], round(float(value), 2)])
        except ValueError:
            continue  # "." marks a missing value
    return rows


def price_summary(series: list[list[Any]]) -> dict[str, Any]:
    if not series:
        return {}
    latest_month, latest = series[-1]
    year_ago = next((v for m, v in reversed(series) if m == f"{int(latest_month[:4]) - 1}{latest_month[4:]}"), None)
    return {"latest_month": latest_month, "latest": latest,
            "change_12m_pct": round(100 * (latest - year_ago) / year_ago, 1) if year_ago else None}


def fetch_price(crop_id: str) -> dict[str, Any]:
    info = CROPS[crop_id]["price"]
    series = parse_fred_csv(services._get_text(FRED_CSV_URL.format(series=info["series"])))
    if not series:
        raise services.UpstreamError(f"No price data for {crop_id}")
    return {**info, "series": series, **price_summary(series), "source_url": f"https://fred.stlouisfed.org/series/{info['series']}"}


# --------------------------------------------------------------------------
# Combined data for the Crops page
# --------------------------------------------------------------------------

def public_info() -> dict[str, Any]:
    return {
        "crops": {cid: {k: v for k, v in c.items() if k != "keywords"} for cid, c in CROPS.items()},
        "regions": REGIONS,
        "outlooks": OUTLOOKS,
    }


def get_crops(previous: dict[str, Any] | None = None, max_age_hours: float = 20) -> dict[str, Any]:
    """Prices and growing-region rainfall. Reuses `previous` data if it is recent
    (rainfall and monthly prices change slowly), so frequent builds stay light."""
    now = dt.datetime.now(dt.timezone.utc)
    fresh = False
    if previous and previous.get("built_at"):
        try:
            age = now - dt.datetime.fromisoformat(previous["built_at"])
            fresh = age < dt.timedelta(hours=max_age_hours)
        except ValueError:
            pass
    if fresh:
        return previous

    old_rain = (previous or {}).get("rain", {})
    old_prices = (previous or {}).get("prices", {})

    def safe(fn, key, fallback):
        try:
            return key, fn(), True
        except (services.UpstreamError, KeyError, TypeError, ValueError) as exc:
            log.warning("Crops: %s failed: %s", key, exc)
            return key, fallback, False

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        price_jobs = [pool.submit(safe, lambda c=c: fetch_price(c), c, old_prices.get(c)) for c in CROPS]
        rain_jobs = [pool.submit(safe, lambda r=r: fetch_rain(r), r["id"], old_rain.get(r["id"])) for r in REGIONS]
        prices = {k: v for k, v, _ in (j.result() for j in price_jobs) if v}
        rain = {k: v for k, v, _ in (j.result() for j in rain_jobs) if v}

    if not prices and not rain:
        raise services.UpstreamError("No crop data could be fetched")
    return {"built_at": now.isoformat(timespec="seconds"), "prices": prices, "rain": rain}
