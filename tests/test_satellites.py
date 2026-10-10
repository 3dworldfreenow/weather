import datetime as dt

import pytest

from weather_app import create_app, satellites, services

GIBS_XML = b"""<?xml version="1.0"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1">
 <Contents>
  <Layer><ows:Identifier>GOES-East_ABI_Band13_Clean_Infrared</ows:Identifier>
   <Format>image/png</Format>
   <TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible_Level7</TileMatrixSet></TileMatrixSetLink></Layer>
  <Layer><ows:Identifier>GOES-West_ABI_Band13_Clean_Infrared</ows:Identifier>
   <Format>image/png</Format>
   <TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible_Level6</TileMatrixSet></TileMatrixSetLink></Layer>
  <Layer><ows:Identifier>Himawari_AHI_Band13_Clean_Infrared</ows:Identifier>
   <Format>image/png</Format>
   <TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible_Level6</TileMatrixSet></TileMatrixSetLink></Layer>
  <Layer><ows:Identifier>MODIS_Terra_CorrectedReflectance_TrueColor</ows:Identifier>
   <Format>image/jpeg</Format>
   <TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible_Level9</TileMatrixSet></TileMatrixSetLink></Layer>
 </Contents>
</Capabilities>"""

WMS_XML = b"""<?xml version="1.0"?>
<WMS_Capabilities xmlns="http://www.opengis.net/wms" version="1.3.0">
 <Capability><Layer><Name>root</Name>
  <Layer><Name>mtg_fd:ir105_hrfi</Name></Layer>
  <Layer><Name>msg_fes:ir108</Name></Layer>
  <Layer><Name>msg_iodc:ir108</Name></Layer>
  <Layer><Name>msg_iodc:rgb_dust</Name></Layer>
 </Layer></Capability>
</WMS_Capabilities>"""

NOW = dt.datetime(2026, 10, 10, 12, 57, tzinfo=dt.timezone.utc)


@pytest.fixture(autouse=True)
def clear_cache():
    services.cache.clear()
    yield
    services.cache.clear()


def fake_download(monkeypatch, gibs=GIBS_XML, wms=WMS_XML):
    calls = []

    def download(url):
        calls.append(url)
        if isinstance(gibs, Exception) and url == satellites.GIBS_CAPABILITIES:
            raise gibs
        if isinstance(wms, Exception) and url == satellites.EUMETVIEW_CAPABILITIES:
            raise wms
        return gibs if url == satellites.GIBS_CAPABILITIES else wms

    monkeypatch.setattr(satellites, "_download", download)
    return calls


def test_parse_gibs_layers():
    layers = satellites.parse_gibs_layers(GIBS_XML)
    assert layers["GOES-East_ABI_Band13_Clean_Infrared"] == {
        "matrix_set": "GoogleMapsCompatible_Level7", "ext": "png"}
    assert layers["MODIS_Terra_CorrectedReflectance_TrueColor"]["ext"] == "jpg"


def test_parse_wms_layer_names():
    assert "msg_iodc:ir108" in satellites.parse_wms_layer_names(WMS_XML)


def test_latest_image_time_rounds_down_with_latency():
    assert satellites.latest_image_time(NOW) == "2026-10-10T12:10:00Z"


def test_bands_cover_the_whole_globe_without_gaps():
    bands = [s["band"] for s in satellites.SATELLITES]
    for (_, e), (w, _) in zip(bands, bands[1:]):
        assert e == pytest.approx(w)
    assert bands[-1][1] - bands[0][0] == pytest.approx(360)


def test_get_satellites_discovers_layers(monkeypatch):
    fake_download(monkeypatch)
    data = satellites.get_satellites(NOW)
    by_id = {layer["id"]: layer for layer in data["layers"]}
    assert list(by_id) == ["goes_west", "goes_east", "meteosat", "iodc", "himawari"]
    east = by_id["goes_east"]
    assert east["type"] == "wmts" and east["verified"]
    assert east["max_native_zoom"] == 7
    assert east["url"] == (
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/"
        "default/2026-10-10T12:10:00Z/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png")
    assert by_id["meteosat"]["layer"] == "mtg_fd:ir105_hrfi"  # newest satellite preferred
    assert by_id["iodc"]["layer"] == "msg_iodc:ir108"
    assert by_id["iodc"]["type"] == "wms"


def test_capabilities_are_cached(monkeypatch):
    calls = fake_download(monkeypatch)
    satellites.get_satellites(NOW)
    satellites.get_satellites(NOW)
    assert len(calls) == 2  # one per provider


def test_falls_back_to_known_names_when_provider_unreachable(monkeypatch):
    import requests
    fake_download(monkeypatch, gibs=requests.ConnectionError("offline"))
    data = satellites.get_satellites(NOW)
    by_id = {layer["id"]: layer for layer in data["layers"]}
    assert by_id["himawari"]["layer"] == "Himawari_AHI_Band13_Clean_Infrared"
    assert by_id["himawari"]["verified"] is False
    assert by_id["iodc"]["verified"] is True


def test_satellite_missing_from_catalogue_is_skipped(monkeypatch):
    fake_download(monkeypatch, wms=WMS_XML.replace(b"msg_iodc:ir108", b"other"))
    ids = [layer["id"] for layer in satellites.get_satellites(NOW)["layers"]]
    assert "iodc" not in ids


def test_api_endpoint(monkeypatch):
    fake_download(monkeypatch)
    resp = create_app({"TESTING": True}).test_client().get("/api/satellites")
    assert resp.status_code == 200
    assert len(resp.get_json()["layers"]) == 5
