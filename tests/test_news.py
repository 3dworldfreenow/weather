import pytest

from weather_app import create_app, news, services

GDELT = {"articles": [
    {"url": "https://example.in/el-nino-monsoon", "title": "El Nino may weaken India's monsoon",
     "seendate": "20261010T083000Z", "socialimage": "https://example.in/img.jpg",
     "domain": "example.in", "language": "English", "sourcecountry": "India"},
    {"url": "https://example.pe/fenomeno", "title": "Fenómeno El Niño: alerta en la costa",
     "seendate": "20261009T120000Z", "socialimage": "http://insecure.example/img.jpg",
     "domain": "example.pe", "language": "Spanish", "sourcecountry": "Peru"},
    {"url": "javascript:alert(1)", "title": "Bad link", "seendate": "20261009T120000Z"},
]}

GOOGLE_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>"El Niño" - Google News</title>
<item><title>El Nino may weaken India's monsoon - The Example Times</title>
  <link>https://news.google.com/rss/articles/abc</link>
  <pubDate>Fri, 10 Oct 2026 07:00:00 GMT</pubDate>
  <source url="https://example.in">The Example Times</source></item>
<item><title>Farmers prepare for El Niño - Daily News</title>
  <link>https://news.google.com/rss/articles/def</link>
  <pubDate>Sat, 10 Oct 2026 09:00:00 GMT</pubDate>
  <source url="https://daily.example">Daily News</source></item>
</channel></rss>"""

YOUTUBE_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
 <entry><yt:videoId>AbCdEfGhIjK</yt:videoId><title>El Niño update: October 2026</title>
  <author><name>NOAA</name></author><published>2026-10-08T15:00:00+00:00</published>
  <media:group><media:description>Monthly ENSO update</media:description></media:group></entry>
 <entry><yt:videoId>ZyXwVuTsRqP</yt:videoId><title>Hurricane season recap</title>
  <author><name>NOAA</name></author><published>2026-10-07T15:00:00+00:00</published>
  <media:group><media:description>Atlantic storms</media:description></media:group></entry>
 <entry><yt:videoId>bad id</yt:videoId><title>El Niño</title></entry>
</feed>"""

CHANNEL_PAGE = '<html><link rel="canonical" href="https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa"></html>'


@pytest.fixture(autouse=True)
def clear_cache():
    services.cache.clear()
    yield
    services.cache.clear()


def test_parse_gdelt_keeps_safe_links_and_https_images():
    articles = news.parse_gdelt(GDELT)
    assert [a["country"] for a in articles] == ["India", "Peru"]
    assert articles[0]["published"] == "2026-10-10T08:30:00+00:00"
    assert articles[0]["image"] == "https://example.in/img.jpg"
    assert articles[1]["image"] is None  # http images are dropped


def test_parse_google_news_strips_publisher_from_title():
    articles = news.parse_google_news(GOOGLE_RSS, "India", "English")
    assert articles[0]["title"] == "El Nino may weaken India's monsoon"
    assert articles[0]["source"] == "The Example Times"
    assert articles[0]["published"] == "2026-10-10T07:00:00+00:00"
    assert articles[0]["country"] == "India"


def test_parse_youtube_feed_keeps_only_el_nino_videos():
    videos = news.parse_youtube_feed(YOUTUBE_FEED, "NOAA")
    assert [v["id"] for v in videos] == ["AbCdEfGhIjK"]
    assert videos[0]["channel"] == "NOAA"


def test_merge_dedupes_by_title_and_sorts_newest_first():
    merged = news.merge_articles([news.parse_gdelt(GDELT), news.parse_google_news(GOOGLE_RSS, "India", "English")])
    titles = [a["title"] for a in merged]
    assert titles.count("El Nino may weaken India's monsoon") == 1
    assert titles[0] == "Farmers prepare for El Niño"
    assert [a["published"] for a in merged] == sorted((a["published"] for a in merged), reverse=True)


def test_resolve_channel_id_from_handle_and_fallback(monkeypatch):
    monkeypatch.setattr(services, "_get_text", lambda url: CHANNEL_PAGE)
    assert news.resolve_channel_id({"handle": "NOAA", "fallback": None}) == "UCaaaaaaaaaaaaaaaaaaaaaa"

    def down(url):
        raise services.UpstreamError("down")
    monkeypatch.setattr(services, "_get_text", down)
    assert news.resolve_channel_id({"handle": "metoffice", "fallback": "UCbbbbbbbbbbbbbbbbbbbbbb"}) == "UCbbbbbbbbbbbbbbbbbbbbbb"


def fake_sources(monkeypatch, google_ok=True, gdelt_ok=True):
    def get_json(url, params=None):
        if not gdelt_ok:
            raise services.UpstreamError("gdelt down")
        return GDELT

    def get_text(url):
        if url.startswith("https://news.google.com"):
            if not google_ok:
                raise services.UpstreamError("google down")
            return GOOGLE_RSS
        if "/@" in url:
            return CHANNEL_PAGE
        return YOUTUBE_FEED

    monkeypatch.setattr(services, "_get_json", get_json)
    monkeypatch.setattr(services, "_get_text", get_text)


def test_get_news_combines_everything(monkeypatch):
    fake_sources(monkeypatch)
    data = news.get_news()
    assert len(data["articles"]) == 3
    assert [v["id"] for v in data["videos"]] == ["AbCdEfGhIjK", "57S0Rw9L_hw"]  # deduped
    assert data["videos"][-1]["explainer"] is True
    assert all(s["ok"] for s in data["sources"])
    assert len(data["sources"]) == (1 + len(news.GOOGLE_NEWS_EDITIONS) + len(news.THEME_QUERIES)
                                    + len(news.CROP_QUERIES) + 1 + len(news.YOUTUBE_CHANNELS))


def test_get_news_survives_some_sources_failing(monkeypatch):
    fake_sources(monkeypatch, google_ok=False)
    data = news.get_news()
    assert len(data["articles"]) == 2
    assert not [s for s in data["sources"] if s["name"].startswith("Google") and s["ok"]]


def test_get_news_fails_when_all_news_sources_fail(monkeypatch):
    fake_sources(monkeypatch, google_ok=False, gdelt_ok=False)
    with pytest.raises(services.UpstreamError):
        news.get_news()


def test_api_news(monkeypatch):
    fake_sources(monkeypatch)
    resp = create_app({"TESTING": True}).test_client().get("/api/news")
    assert resp.status_code == 200
    assert resp.get_json()["youtube_search"].startswith("https://www.youtube.com/results")


def test_gdelt_retries_after_rate_limit(monkeypatch):
    calls = []

    def get_json(url, params=None):
        calls.append(url)
        if len(calls) < 3:
            raise services.UpstreamError("429", status=429)
        return GDELT

    monkeypatch.setattr(services, "_get_json", get_json)
    monkeypatch.setattr(news.time, "sleep", lambda s: None)
    assert len(news.fetch_gdelt()) == 2
    assert len(calls) == 3


def test_gdelt_gives_up_after_retries(monkeypatch):
    def get_json(url, params=None):
        raise services.UpstreamError("429", status=429)

    monkeypatch.setattr(services, "_get_json", get_json)
    monkeypatch.setattr(news.time, "sleep", lambda s: None)
    with pytest.raises(services.UpstreamError):
        news.fetch_gdelt()


def test_articles_are_tagged_with_themes_and_countries():
    merged = news.merge_articles([[
        {"title": "El Nino may weaken India's monsoon, hurting rice crops", "url": "https://a.example/1",
         "source": "a", "country": "India", "language": "English", "published": "2026-10-10T00:00:00+00:00",
         "image": None, "via": "Google News", "edition": "india"},
        {"title": "Dengue cases rise in Peru as El Niño floods the coast", "url": "https://b.example/2",
         "source": "b", "country": None, "language": "English", "published": "2026-10-09T00:00:00+00:00",
         "image": None, "via": "Google News", "theme_hint": "health"},
        {"title": "Panama Canal limits ships as El Niño drought drains lakes", "url": "https://c.example/3",
         "source": "c", "country": "United States", "language": "English", "published": "2026-10-08T00:00:00+00:00",
         "image": None, "via": "Google News", "edition": "united-states"},
    ]])
    india, peru, panama = merged
    assert india["countries"] == ["india"] and "food" in india["themes"]
    assert peru["countries"] == ["peru"] and {"health", "floods"} <= set(peru["themes"])
    assert set(panama["countries"]) == {"panama", "united-states"}
    assert {"drought", "economy"} <= set(panama["themes"])
    assert "edition" not in india and "theme_hint" not in peru
    assert india["crops"] == ["rice"] and peru["crops"] == []


def test_crop_search_hint_tags_the_crop():
    merged = news.merge_articles([[
        {"title": "Mills brace for a weaker harvest as El Niño looms", "url": "https://s.example/1", "source": "s",
         "country": None, "language": "English", "published": "2026-10-10T00:00:00+00:00", "image": None,
         "via": "Google News", "theme_hint": "food", "crop_hint": "sugar"},
    ]])
    assert merged[0]["crops"] == ["sugar"] and "food" in merged[0]["themes"]
    assert "crop_hint" not in merged[0]


def test_duplicate_articles_merge_their_tags():
    a = {"title": "El Niño drought hits crops", "url": "https://a.example/1", "source": "a", "country": "India",
         "language": "English", "published": "2026-10-10T00:00:00+00:00", "image": None, "via": "Google News",
         "edition": "india"}
    b = {**a, "url": "https://b.example/1", "edition": "pakistan", "theme_hint": "forecast"}
    merged = news.merge_articles([[a], [b]])
    assert len(merged) == 1
    assert merged[0]["countries"] == ["india", "pakistan"]
    assert "forecast" in merged[0]["themes"]
