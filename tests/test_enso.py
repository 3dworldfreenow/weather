import datetime as dt

import pytest

from weather_app import create_app, enso, satellites, services

WEEKLY = """
 Weekly SST data starts week centered on 3Jan1990

                Nino1+2      Nino3        Nino34        Nino4
 Week          SST SSTA     SST SSTA     SST SSTA     SST SSTA
 03SEP2025     20.1-0.4     24.9-0.2     26.6-0.3     28.6 0.1
 10SEP2025     20.3-0.2     25.0 0.0     26.7-0.1     28.7 0.2
 17SEP2025     20.6 0.1     25.2 0.2     26.9 0.1     28.8 0.3
 24SEP2025     21.0 0.6     25.4 0.4     27.1 0.3     28.8 0.3
 01OCT2025     21.6 1.2     25.7 0.7     27.3 0.6     28.9 0.4
"""

ONI = """SEAS  YR   TOTAL   ANOM
 MJJ 2025  27.71  -0.09
 JJA 2025  27.32  -0.05
 JAS 2025  26.95   0.10
"""


@pytest.fixture(autouse=True)
def clear_cache():
    services.cache.clear()
    yield
    services.cache.clear()


def test_parse_weekly_handles_joined_numbers():
    rows = enso.parse_weekly(WEEKLY)
    assert len(rows) == 5
    assert rows[0]["week"] == "2025-09-03"
    assert rows[0]["nino12"] == {"sst": 20.1, "anomaly": -0.4}
    assert rows[-1]["nino34"] == {"sst": 27.3, "anomaly": 0.6}


def test_parse_oni():
    oni = enso.parse_oni(ONI)
    assert oni[-1] == {"season": "JAS", "year": 2025, "anomaly": 0.10}


@pytest.mark.parametrize("anomaly,expected", [
    (0.2, ("neutral", "")), (0.5, ("el_nino", "weak")), (1.2, ("el_nino", "moderate")),
    (1.7, ("el_nino", "strong")), (2.3, ("el_nino", "very strong")), (-0.8, ("la_nina", "weak")),
])
def test_classify(anomaly, expected):
    assert enso.classify(anomaly) == expected


def test_summary_finds_where_el_nino_is_building():
    summary = enso.summarise(enso.parse_weekly(WEEKLY), enso.parse_oni(ONI))
    assert summary["phase"] == "el_nino"
    assert summary["nino34_anomaly"] == 0.6
    assert summary["trend_4w"] == pytest.approx(0.9)
    assert "strengthening" in summary["headline"]
    assert summary["focus"]["id"] == "nino12"  # warmest anomaly, near South America
    assert "Niño 1+2" in summary["focus"]["text"]
    region = {r["id"]: r for r in summary["regions"]}["nino4"]
    assert region["west"] == -200 and region["east"] == -150  # continuous across the date line
    assert region["history"] == [0.1, 0.2, 0.3, 0.3, 0.4]


def test_neutral_but_warming():
    text = WEEKLY.replace("27.3 0.6", "27.1 0.3").replace("26.6-0.3", "26.6-0.1")
    summary = enso.summarise(enso.parse_weekly(text), [])
    assert summary["phase"] == "neutral"
    assert summary["headline"] == "Neutral, but the Pacific is warming toward El Niño"


def test_sst_layer_uses_catalogue_and_recent_date(monkeypatch):
    monkeypatch.setattr(satellites, "_catalogue", lambda source: {
        "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies": {
            "matrix_set": "GoogleMapsCompatible_Level7", "ext": "png"}})
    layer = enso.sst_anomaly_layer(dt.date(2026, 10, 10))
    assert layer["date"] == "2026-10-08"
    assert layer["max_native_zoom"] == 7
    assert "/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-10-08/" in layer["url"]


def test_api_enso(monkeypatch):
    monkeypatch.setattr(services, "_get_text", lambda url: WEEKLY if url == enso.WEEKLY_URL else ONI)
    monkeypatch.setattr(satellites, "_catalogue", lambda source: None)
    resp = create_app({"TESTING": True}).test_client().get("/api/enso")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["focus"]["id"] == "nino12"
    assert data["sst_layer"]["layer"] == "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies"
    assert len(data["sources"]) == 4


def test_api_enso_upstream_down(monkeypatch):
    def down(url):
        raise services.UpstreamError("down")
    monkeypatch.setattr(services, "_get_text", down)
    resp = create_app({"TESTING": True}).test_client().get("/api/enso")
    assert resp.status_code == 502
