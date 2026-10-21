import datetime as dt

import pytest

from weather_app import services, stations

CSV = """raw_text,station_id,observation_time,latitude,longitude,temp_c,dewpoint_c,wx_string
"METAR LFSN 211130Z RA",LFSN,2026-10-21T11:30:00.000Z,48.692,6.231,10,9,RA BR
"METAR LFSN 211100Z",LFSN,2026-10-21T11:00:00.000Z,48.692,6.231,13,9,
"METAR XXXX bad",XXXX,not-a-time,1,2,3,4,
"METAR LFQA 211130Z",LFQA,2026-10-21T11:30:00.000Z,49.21,4.155,,10,
"""
NOW = dt.datetime(2026, 10, 21, 11, 40, tzinfo=dt.timezone.utc)
MIN = int(dt.datetime(2026, 10, 21, 11, 30, tzinfo=dt.timezone.utc).timestamp() // 60)


def test_parse_keeps_newest_report_per_station():
    out = stations.parse(CSV)
    assert set(out) == {"LFSN", "LFQA"}
    assert out["LFSN"]["obs"] == [[MIN, 10.0, "RA BR"]]
    assert out["LFQA"]["obs"][0][1] is None


def test_merge_builds_history_and_drops_old_reports():
    previous = {"stations": [
        ["LFSN", 48.692, 6.231, [[MIN - 60, 13.0, ""], [MIN - 400, 15.0, ""]]],
        ["GONE", 1.0, 2.0, [[MIN - 500, 20.0, ""]]],
    ]}
    merged = {s[0]: s for s in stations.merge(stations.parse(CSV), previous, NOW)}
    assert merged["LFSN"][3] == [[MIN - 60, 13.0, ""], [MIN, 10.0, "RA BR"]]
    assert "GONE" not in merged and "LFQA" in merged


def test_failed_download_keeps_previous(monkeypatch):
    def boom():
        raise services.UpstreamError("down")
    monkeypatch.setattr(stations, "_download", boom)
    prev = {"built_at": "x", "stations": []}
    assert stations.get_stations(prev, NOW) is prev
    with pytest.raises(services.UpstreamError):
        stations.get_stations(None, NOW)
