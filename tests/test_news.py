import pytest

from weather_app import create_app, impacts, news, services

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


BING_RSS = """<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:News="https://www.bing.com/news/search?q=El+Nino&amp;format=rss" version="2.0"><channel>
<item><title>Monsoon deficit grows as El Nino takes hold</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fpaper.example%2fmonsoon&amp;c=1</link>
<description>Rain is 12% below normal.</description><pubDate>Tue, 13 Oct 2026 08:00:00 GMT</pubDate>
<News:Source>The Paper</News:Source><News:Image>https://img.example/a.jpg</News:Image></item>
</channel></rss>"""

RELIEFWEB_RSS = """<rss version="2.0"><channel>
<item><title>Southern Africa: El Niño drought response plan 2026</title><link>https://reliefweb.int/report/1</link>
<description>&lt;p&gt;Appeal for USD 300 million.&lt;/p&gt;</description><pubDate>Mon, 12 Oct 2026 10:00:00 +0000</pubDate></item>
</channel></rss>"""

SCIENCE_RSS = """<rss version="2.0"><channel>
<item><title>Warm Pacific waters signal a strengthening El Niño</title><link>https://science.example/enso</link>
<pubDate>Sun, 11 Oct 2026 10:00:00 +0000</pubDate></item>
<item><title>New beetle species found</title><link>https://science.example/beetle</link></item>
</channel></rss>"""

ARXIV_ATOM = """<feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/2610.00001v1</id><published>2026-10-10T00:00:00Z</published>
<title>Deep learning forecasts of ENSO
  at long lead times</title><summary>We predict El Nino.</summary>
<link href="http://arxiv.org/abs/2610.00001v1" rel="alternate" type="text/html"/></entry>
</feed>"""

CROSSREF = {"message": {"items": [
    {"title": ["El Niño impacts on maize yields in Zambia"], "URL": "https://doi.org/10.1/x",
     "published": {"date-parts": [[2026, 9]]}, "container-title": ["Agricultural Systems"]},
    {"title": ["Unrelated chemistry"], "URL": "https://doi.org/10.1/y"},
]}}
HN = {"hits": [{"title": "El Niño is back, what it means", "url": "https://blog.example/enso", "objectID": "42",
                "num_comments": 17, "created_at": "2026-10-09T10:00:00Z"}]}
ITUNES = {"results": [{"trackName": "Episode 12: El Niño and your coffee", "trackViewUrl": "https://podcasts.apple.com/ep12",
                       "collectionName": "Climate Talk", "releaseDate": "2026-10-08T05:00:00Z",
                       "artworkUrl160": "https://img.example/p.jpg", "description": "Why prices rise."}]}


PAPERS = [
    {"country": "India", "slug": "india", "language": "Hindi", "publisher": "Dainik Example",
     "url": "https://hindi.example/rss", "type": "page"},
    {"country": "Peru", "slug": "peru", "language": "Spanish", "publisher": "Diario Ejemplo",
     "url": "https://diario.example/feed/", "type": "feed"},
]
FEEDS_PAGE = """<html><head><link rel="alternate" type="application/rss+xml" href="/rss/home.xml"></head>
<body><a href="/rss/national.xml">National</a> <a href="https://other.example/rss.xml">Other site</a>
<a href="/about">About</a> <a href="/rss/sports.xml">Sports</a> <a href="/rss/world.xml">World</a></body></html>"""
HINDI_RSS = """<rss version="2.0"><channel>
<item><title>अल नीनो से मानसून कमजोर, किसान परेशान</title><link>https://hindi.example/a/1</link>
<pubDate>Tue, 13 Oct 2026 06:00:00 +0530</pubDate></item>
<item><title>क्रिकेट: भारत जीता</title><link>https://hindi.example/a/2</link></item>
</channel></rss>"""
SPANISH_RSS = """<rss version="2.0"><channel>
<item><title>Fenómeno El Niño: alerta en Piura</title><link>https://diario.example/1</link></item>
<item><title>Rescatan a la niña perdida en Lima</title><link>https://diario.example/2</link></item>
</channel></rss>"""


def fake_sources(monkeypatch, google_ok=True, gdelt_ok=True, others_ok=True):
    monkeypatch.setattr(news, "load_feeds", lambda: PAPERS)
    def get_json(url, params=None):
        if url == news.GDELT_URL:
            if not gdelt_ok:
                raise services.UpstreamError("gdelt down")
            return GDELT
        if not others_ok:
            raise services.UpstreamError("down")
        return {news.CROSSREF_URL: CROSSREF, news.HN_URL: HN, news.ITUNES_URL: ITUNES}[url]

    def get_text(url):
        if url.startswith("https://news.google.com") and "reliefweb" in url and others_ok:
            return RELIEFWEB_RSS
        if url.startswith("https://news.google.com"):
            if not google_ok:
                raise services.UpstreamError("google down")
            return GOOGLE_RSS
        if "/@" in url:
            return CHANNEL_PAGE
        if "youtube.com" in url:
            return YOUTUBE_FEED
        if not others_ok:
            raise services.UpstreamError("down")
        if "bing.com" in url:
            return BING_RSS
        if "reliefweb" in url:
            return RELIEFWEB_RSS
        if "arxiv" in url:
            return ARXIV_ATOM
        if url == "https://hindi.example/rss":
            return FEEDS_PAGE
        if url.startswith("https://hindi.example/rss/"):
            return HINDI_RSS
        if url == "https://diario.example/feed/":
            return SPANISH_RSS
        return SCIENCE_RSS

    monkeypatch.setattr(services, "_get_json", get_json)
    monkeypatch.setattr(services, "_get_text", get_text)


def test_get_news_combines_everything(monkeypatch):
    fake_sources(monkeypatch)
    data = news.get_news()
    kinds = {}
    for a in data["articles"]:
        kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
    assert kinds == {"news": 6, "report": 1, "science": 1, "paper": 2, "discussion": 1, "podcast": 1}
    hindi = next(a for a in data["articles"] if a["url"] == "https://hindi.example/a/1")
    assert hindi["source"] == "Dainik Example" and hindi["language"] == "Hindi" and "india" in hindi["countries"]
    assert not any("niña perdida" in a["title"] for a in data["articles"])  # "la niña" = "the girl"
    assert [v["id"] for v in data["videos"]] == ["AbCdEfGhIjK", "57S0Rw9L_hw"]  # deduped
    assert data["videos"][-1]["explainer"] is True
    assert all(s["ok"] for s in data["sources"])
    assert len(data["sources"]) == (1 + len(news.GOOGLE_NEWS_EDITIONS) + len(news.THEME_QUERIES)
                                    + len(news.CROP_QUERIES) + 1 + len(news.BING_MARKETS) + 1 + len(news.FEEDS)
                                    + 4 + len(PAPERS) + len(news.WEATHER_EDITIONS) + len(news.YOUTUBE_CHANNELS))


def test_get_news_survives_some_sources_failing(monkeypatch):
    fake_sources(monkeypatch, google_ok=False, others_ok=False)
    data = news.get_news()
    assert len(data["articles"]) == 2
    assert not [s for s in data["sources"] if s["name"].startswith("Google") and s["ok"]]


def test_get_news_fails_when_all_news_sources_fail(monkeypatch):
    fake_sources(monkeypatch, google_ok=False, gdelt_ok=False, others_ok=False)
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


def test_new_sources_are_parsed():
    bing = news.parse_feed(BING_RSS, "Bing News", "news", "Bing News", topic_only=False)
    assert bing[0]["url"] == "https://paper.example/monsoon"  # Bing redirect unwrapped
    assert bing[0]["source"] == "The Paper" and bing[0]["image"] == "https://img.example/a.jpg"
    assert bing[0]["published"] == "2026-10-13T08:00:00+00:00"

    relief = news.parse_feed(RELIEFWEB_RSS, "ReliefWeb", "report", "ReliefWeb", topic_only=False)
    assert relief[0]["summary"] == "Appeal for USD 300 million." and relief[0]["kind"] == "report"

    broken = SCIENCE_RSS.replace("Warm Pacific waters", "Sun & sea: warm Pacific waters")  # bare "&"
    assert news.parse_feed(broken, "NASA", "science", "NASA")[0]["title"].startswith("Sun & sea")

    science = news.parse_feed(SCIENCE_RSS, "Phys.org", "science", "Phys.org")
    assert [a["url"] for a in science] == ["https://science.example/enso"]  # off-topic items dropped

    paper = news.parse_feed(ARXIV_ATOM, "arXiv", "paper", "arXiv")[0]
    assert paper["title"] == "Deep learning forecasts of ENSO at long lead times"
    assert paper["url"] == "http://arxiv.org/abs/2610.00001v1" and paper["published"].startswith("2026-10-10")

    crossref = news.parse_crossref(CROSSREF)
    assert len(crossref) == 1 and crossref[0]["source"] == "Agricultural Systems"
    assert crossref[0]["published"].startswith("2026-09-01")

    hn = news.parse_hn(HN)[0]
    assert hn["discussion"] == "https://news.ycombinator.com/item?id=42" and hn["kind"] == "discussion"
    pod = news.parse_podcasts(ITUNES)[0]
    assert pod["source"] == "Climate Talk" and pod["kind"] == "podcast"


def test_other_kinds_are_capped_separately():
    many = [{"title": f"El Niño paper {i}", "url": f"https://p.example/{i}", "source": "j", "country": None,
             "language": "English", "published": None, "image": None, "via": "x", "kind": "paper"} for i in range(200)]
    merged = news.merge_articles([many, [{**many[0], "title": "El Niño news", "kind": "news"}]])
    assert sum(a["kind"] == "paper" for a in merged) == news.MAX_PER_KIND
    assert sum(a["kind"] == "news" for a in merged) == 1


def test_news_page(monkeypatch):
    fake_sources(monkeypatch)
    app = create_app({"TESTING": True})
    news.get_news()  # fills the cache the page pre-renders from
    html = app.test_client().get("/news/").get_data(as_text=True)
    assert "<h1>El Niño &amp; weather news</h1>" in html
    assert 'id="news-kinds"' in html and "js/news.js" in html
    assert '"@type": "CollectionPage"' in html and '"ItemList"' in html
    assert "Monsoon deficit grows as El Nino takes hold" in html  # headlines pre-rendered


def test_feed_list_is_valid():
    feeds = news.load_feeds()
    assert len(feeds) > 100
    urls = [f["url"] for f in feeds]
    assert len(urls) == len(set(urls))
    for f in feeds:
        assert f["url"].startswith(("http://", "https://")) and f["type"] in ("feed", "page")
        assert f["category"] in news.FEED_CATEGORIES and f["filter"] in ("topic", "all")
        assert f["language"] or f["origin"] != "curated"  # imported rows may not know their language
        assert not f["slug"] or f["slug"] in impacts.BY_SLUG, f
    covered = {f["slug"] for f in feeds if f["slug"]}
    assert len(covered) >= 40  # most countries we cover have their own papers (others: Google News, AllAfrica, RNZ Pacific)


def test_discover_feeds_from_a_feed_list_page():
    urls = news.discover_feeds(FEEDS_PAGE, "https://hindi.example/rss")
    assert urls == ["https://hindi.example/rss/home.xml", "https://hindi.example/rss/national.xml",
                    "https://hindi.example/rss/world.xml"]  # own site only, main sections first


def test_weather_and_el_nino_flags():
    merged = news.merge_articles([[
        {"title": "Cyclone nears Odisha coast, heavy rain warning", "url": "https://w.example/1", "source": "w",
         "country": "India", "language": "English", "published": None, "image": None, "via": "x", "scope_hint": "feed"},
        {"title": "El Niño may weaken the monsoon", "url": "https://w.example/2", "source": "w", "country": None,
         "language": "English", "published": None, "image": None, "via": "x"},
        {"title": "Mills shut for Diwali", "url": "https://w.example/3", "source": "w", "country": None,
         "language": "English", "published": None, "image": None, "via": "x", "scope_hint": "weather"},
    ]])
    by_url = {a["url"]: a for a in merged}
    assert by_url["https://w.example/1"]["weather"] and not by_url["https://w.example/1"]["elnino"]
    assert by_url["https://w.example/2"]["elnino"] and by_url["https://w.example/2"]["weather"]  # "monsoon"
    assert by_url["https://w.example/3"]["weather"] and not by_url["https://w.example/3"]["elnino"]  # weather search


def test_feeds_keep_weather_stories_when_asked():
    rss = SCIENCE_RSS.replace("New beetle species found", "Record heatwave hits Europe")
    assert len(news.parse_feed(rss, "x", "news", "x")) == 1
    assert len(news.parse_feed(rss, "x", "news", "x", weather=True)) == 2


def test_weather_service_feeds_keep_every_item(monkeypatch):
    warnings = """<rss version="2.0"><channel>
<item><title>Yellow warning: thunderstorms in the south east</title><link>https://met.example/w/1</link></item>
<item><title>Amber warning issued for the Highlands</title><link>https://met.example/w/2</link></item>
</channel></rss>"""
    monkeypatch.setattr(services, "_get_text", lambda url: warnings)
    service = {"country": "", "slug": "", "language": "English", "publisher": "Met Example", "url": "https://met.example/rss",
               "type": "feed", "category": "weather", "filter": "all"}
    items = news.fetch_publisher(service)
    assert len(items) == 2 and {a["kind"] for a in items} == {"official"}
    tagged = news.merge_articles([items])
    assert all(a["weather"] and not a["elnino"] for a in tagged)
    # A newspaper with the default "topic" filter keeps only the El Niño / weather story.
    paper = {**service, "category": "newspaper", "filter": "topic"}
    assert [a["url"] for a in news.fetch_publisher(paper)] == ["https://met.example/w/1"]


def test_import_feeds_classifies_and_writes_csv(tmp_path, monkeypatch):
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
    import import_feeds

    assert import_feeds.classify(["daily newspaper"]) == "newspaper"
    assert import_feeds.classify(["public broadcaster", "company"]) == "tv"
    assert import_feeds.classify(["public university"]) == "university"
    assert import_feeds.classify(["national meteorological service", "government agency"]) == "weather"
    assert import_feeds.classify(["video game", "company"]) is None

    csv_path = tmp_path / "feeds.csv"
    csv_path.write_text("country,slug,language,publisher,url,type,category,filter,origin\n"
                        "India,india,Hindi,Hand Picked,https://hand.example/rss,feed,newspaper,topic,curated\n",
                        encoding="utf-8")
    monkeypatch.setattr(import_feeds, "CSV_PATH", csv_path)
    monkeypatch.setattr(import_feeds, "from_wikidata", lambda s: [
        {"country": "Peru", "language": "Spanish", "publisher": "Diario, Uno", "url": "https://uno.example/feed",
         "category": "newspaper", "origin": "wikidata"},
        {"country": "Peru", "language": "", "publisher": "Dead", "url": "https://dead.example/feed",
         "category": "newspaper", "origin": "wikidata"},
        {"country": "India", "language": "", "publisher": "Dup", "url": "http://www.hand.example/rss/",
         "category": "newspaper", "origin": "wikidata"},
        {"country": "Kenya", "language": "", "publisher": "Kenya Met", "url": "https://met.example/rss",
         "category": "weather", "origin": "wikidata"},
        {"country": "India", "language": "", "publisher": "Redirects to hand-picked", "url": "https://redirect.example/rss",
         "category": "newspaper", "origin": "wikidata"},
    ])
    monkeypatch.setattr(import_feeds, "from_awesome", lambda s: [])
    monkeypatch.setattr(import_feeds, "check_feed", lambda s, c, now: None if "dead" in c["url"] else
                        {**c, "url": "https://hand.example/rss"} if "redirect" in c["url"] else c)
    monkeypatch.setattr(sys, "argv", ["import_feeds.py"])
    import_feeds.main()

    text = csv_path.read_text(encoding="utf-8")
    assert import_feeds.IMPORT_MARKER in text and "Hand Picked" in text
    feeds = news.load_feeds(csv_path)
    assert [f["publisher"] for f in feeds] == ["Hand Picked", "Diario, Uno", "Kenya Met"]  # dead and duplicate dropped
    assert feeds[1]["slug"] == "peru" and feeds[1]["origin"] == "wikidata"
    assert feeds[2]["filter"] == "all" and feeds[2]["slug"] == "kenya"
    import_feeds.main()  # running again replaces the imported part instead of appending
    assert len(news.load_feeds(csv_path)) == 3


def test_imported_feeds_are_read_in_rotation_and_carried_over(monkeypatch):
    feeds = [{"country": "", "slug": "", "language": "English", "publisher": f"Paper {i}", "url": f"https://p{i}.example/rss",
              "type": "feed", "category": "newspaper", "filter": "topic", "origin": "wikidata"} for i in range(60)]
    read = []

    def fake_fetch(feed):
        read.append(feed["url"])
        return [{"title": f"El Niño story from {feed['publisher']}", "url": feed["url"] + "/1", "source": feed["publisher"],
                 "country": None, "language": "English", "published": "2026-10-14T00:00:00+00:00", "image": None,
                 "via": "x", "kind": "news", "scope_hint": "feed"}]

    fake_sources(monkeypatch)
    monkeypatch.setattr(news, "load_feeds", lambda: feeds)
    monkeypatch.setattr(news, "fetch_publisher", fake_fetch)
    now = news.dt.datetime(2026, 10, 14, 6, 0, tzinfo=news.dt.timezone.utc)
    previous = {"articles": [
        {"title": "El Niño older story", "url": "https://old.example/1", "source": "Old", "country": None, "language": "English",
         "published": "2026-10-13T00:00:00+00:00", "image": None, "via": "x", "kind": "news", "rotating": True},
        {"title": "El Niño stale story", "url": "https://old.example/2", "source": "Old", "country": None, "language": "English",
         "published": "2026-09-01T00:00:00+00:00", "image": None, "via": "x", "kind": "news", "rotating": True},
    ]}
    data = news.get_news(previous, now=now)
    slot = news.rotation_slot(now)
    assert read and all(news.in_rotation(u, slot) for u in read) and len(read) < len(feeds)
    assert data["feed_stats"]["imported_feeds"] == 60 and data["feed_stats"]["imported_read"] == len(read)
    urls = {a["url"] for a in data["articles"]}
    assert "https://old.example/1" in urls and "https://old.example/2" not in urls  # recent ones carried over
    assert all(a.get("rotating") for a in data["articles"] if a["url"].endswith("example/rss/1"))
