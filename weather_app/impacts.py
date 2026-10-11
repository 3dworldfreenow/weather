"""Typical El Niño impacts by country and by theme.

These are the *usual* tendencies seen in past El Niño events, summarised from
NOAA Climate.gov, WMO, IRI and national weather services. Every event is
different and other climate drivers (for example the Indian Ocean Dipole)
also matter, so the text says "tends to" / "often" on purpose. Official,
current forecasts come from each country's weather service (linked).

`map_ids` are ISO 3166-1 numeric codes as used by Natural Earth / world-atlas
(static/data/countries.geojson); `map_names` catches shapes without a code.
"""

from __future__ import annotations

import re
from typing import Any

EFFECTS = {
    "drier": {"label": "Drier / drought risk", "color": "#d9822b"},
    "wetter": {"label": "Wetter / flood risk", "color": "#2f7fd8"},
    "warmer": {"label": "Warmer winter", "color": "#d94b4b"},
    "mixed": {"label": "Mixed: wetter in some areas, drier in others", "color": "#9b6ad6"},
}

SOURCES = [
    {"name": "NOAA Climate.gov: El Niño and La Niña impacts",
     "url": "https://www.climate.gov/enso"},
    {"name": "WMO: El Niño / La Niña", "url": "https://wmo.int/topics/el-nino-la-nina"},
    {"name": "IRI (Columbia University): ENSO impacts",
     "url": "https://iri.columbia.edu/our-expertise/climate/enso/"},
]


def _c(slug, name, region, map_ids, lat, lon, effect, season, summary, details, past=(), service=None,
       aliases=(), map_names=()):
    return {
        "slug": slug, "name": name, "region": region, "map_ids": list(map_ids),
        "map_names": list(map_names), "lat": lat, "lon": lon, "effect": effect,
        "season": season, "summary": summary, "details": list(details), "past": list(past),
        "service": {"name": service[0], "url": service[1]} if service else None,
        "aliases": list(aliases),
    }


COUNTRIES: list[dict[str, Any]] = [
    # ---------------- South Asia ----------------
    _c("india", "India", "South Asia", ["356"], 22.5, 79.0, "drier", "June–September monsoon",
       "El Niño years often bring a weaker summer monsoon, with below-normal rain and more heat.",
       ["Many El Niño years have had monsoon deficits and drought in parts of the country, though not every one.",
        "Kharif crops (rice, pulses, oilseeds, sugarcane, cotton) and food prices are sensitive to a weak monsoon.",
        "Lower reservoir levels affect drinking water, irrigation and hydropower.",
        "A positive Indian Ocean Dipole can offset El Niño and support monsoon rain.",
        "The northeast monsoon (October–December) in Tamil Nadu and nearby areas can be wetter."],
       ["2009, 2014 and 2015: El Niño years with below-normal monsoon rainfall.",
        "2023: an El Niño year with a deficient August, among the driest on record."],
       ("India Meteorological Department (IMD)", "https://mausam.imd.gov.in/"),
       aliases=["India", "Indian", "IMD", "Kerala", "Mumbai", "Delhi"]),
    _c("pakistan", "Pakistan", "South Asia", ["586"], 30.0, 70.0, "drier", "July–September monsoon",
       "El Niño tends to weaken monsoon rain, raising drought and heat risk.",
       ["Below-normal monsoon rain affects rain-fed farming and water storage.",
        "Heatwaves are more likely in El Niño summers."],
       [], ("Pakistan Meteorological Department", "https://www.pmd.gov.pk/"), aliases=["Pakistan", "Pakistani"]),
    _c("sri-lanka", "Sri Lanka", "South Asia", ["144"], 7.8, 80.7, "mixed", "October–December wetter",
       "El Niño often brings more rain in the October–December season and drier spells earlier in the year.",
       ["Heavier rain late in the year can cause floods and landslides.",
        "Dry spells mid-year can affect rice planting and hydropower."],
       [], ("Department of Meteorology, Sri Lanka", "https://www.meteo.gov.lk/"), aliases=["Sri Lanka", "Sri Lankan"]),
    _c("bangladesh", "Bangladesh", "South Asia", ["050"], 23.7, 90.3, "mixed", "June–September monsoon",
       "The El Niño link is weaker here; some El Niño years see lower monsoon rain and more heat.",
       ["Heat stress and irregular rain can affect rice crops.",
        "Flooding still depends mostly on rainfall upstream in India, Nepal and Bhutan."],
       [], ("Bangladesh Meteorological Department", "https://live6.bmd.gov.bd/"), aliases=["Bangladesh", "Bangladeshi"]),
    _c("nepal", "Nepal", "South Asia", ["524"], 28.3, 84.1, "drier", "June–September monsoon",
       "El Niño tends to weaken the monsoon, with drier conditions and a higher wildfire risk in the dry season.",
       ["Rice planting depends on monsoon timing.", "Low river flows reduce hydropower output."],
       [], aliases=["Nepal", "Nepali"]),

    # ---------------- Southeast Asia ----------------
    _c("indonesia", "Indonesia", "Southeast Asia", ["360"], -2.5, 118.0, "drier", "June–November",
       "One of the countries most affected: El Niño often brings drought, forest and peat fires, and haze.",
       ["The dry season tends to be longer and drier, especially in Java, Sumatra, Kalimantan and the east.",
        "Peatland fires create haze that can spread to Malaysia and Singapore.",
        "Rice, coffee and palm oil production can fall; water supply comes under stress."],
       ["1997–98 and 2015: severe fires and regional haze during strong El Niño events.",
        "2023: drought and fires during El Niño."],
       ("BMKG", "https://www.bmkg.go.id/"), aliases=["Indonesia", "Indonesian", "Java", "Sumatra", "Kalimantan", "Jakarta"]),
    _c("malaysia", "Malaysia", "Southeast Asia", ["458"], 4.2, 102.0, "drier", "June–November",
       "El Niño tends to bring drier, hotter weather, haze from regional fires and lower palm oil yields.",
       ["Dry spells reduce water levels in dams.",
        "Palm oil output often drops several months after a dry El Niño period."],
       [], ("Malaysian Meteorological Department", "https://www.met.gov.my/"), aliases=["Malaysia", "Malaysian", "Sabah", "Sarawak"]),
    _c("philippines", "Philippines", "Southeast Asia", ["608"], 12.9, 122.0, "drier", "October–April",
       "El Niño often brings below-normal rain and drought from late in the year into the next spring.",
       ["Drought hits rice and corn farms, and water supply in Metro Manila can come under stress.",
        "Fewer tropical cyclones may make landfall in some El Niño years, reducing rainfall further.",
        "PAGASA issues El Niño advisories and alerts."],
       ["1997–98 and 2015–16: widespread drought and crop losses."],
       ("PAGASA", "https://www.pagasa.dost.gov.ph/"), aliases=["Philippines", "Philippine", "Filipino", "PAGASA", "Manila", "Mindanao"]),
    _c("thailand", "Thailand", "Southeast Asia", ["764"], 15.0, 101.0, "drier", "May–October rainy season",
       "El Niño tends to bring a weaker rainy season, lower dam levels and smaller rice and sugar harvests.",
       ["Thailand is a major rice and sugar exporter, so dry years can affect world prices.",
        "Saltwater can intrude into rivers used for tap water around Bangkok in severe dry spells."],
       [], ("Thai Meteorological Department", "https://www.tmd.go.th/"), aliases=["Thailand", "Thai", "Bangkok"]),
    _c("vietnam", "Vietnam", "Southeast Asia", ["704"], 16.0, 107.5, "drier", "Dry season (December–May)",
       "El Niño often brings drought, heat and saltwater intrusion in the Mekong Delta.",
       ["Rice and coffee (Central Highlands) are sensitive to drought.",
        "Low river flows let seawater push inland in the Mekong Delta."],
       ["2015–16: severe drought and saltwater intrusion in the Mekong Delta."],
       aliases=["Vietnam", "Vietnamese", "Mekong"]),
    _c("cambodia", "Cambodia", "Southeast Asia", ["116"], 12.5, 105.0, "drier", "May–October",
       "El Niño tends to bring drier conditions and lower Mekong and Tonle Sap water levels.",
       ["Rice farming and fisheries depend on the annual flood pulse."], [], aliases=["Cambodia", "Cambodian", "Tonle Sap"]),
    _c("myanmar", "Myanmar", "Southeast Asia", ["104"], 21.0, 96.0, "drier", "Monsoon season",
       "El Niño tends to bring a weaker monsoon and more heat.", ["Heat and dry spells affect rice and water supply."],
       [], aliases=["Myanmar", "Burma"]),
    _c("papua-new-guinea", "Papua New Guinea", "Oceania", ["598"], -6.0, 145.0, "drier", "Dry season and beyond",
       "Strong El Niño events can cause severe drought, crop failure, and frost in the highlands.",
       ["Subsistence farming (sweet potato) is hit by drought and highland frost.",
        "Low river levels can disrupt transport and water supply."],
       ["1997–98 and 2015: severe drought and highland frosts."], aliases=["Papua New Guinea", "PNG"]),
    _c("timor-leste", "Timor-Leste", "Southeast Asia", ["626"], -8.8, 125.7, "drier", "Wet season",
       "El Niño tends to delay and weaken the wet season, affecting maize and rice harvests.", [], [],
       aliases=["Timor-Leste", "East Timor"]),

    # ---------------- East Asia ----------------
    _c("china", "China", "East Asia", ["156"], 35.0, 104.0, "mixed", "Varies by region",
       "Effects vary: southern China often gets a wetter winter and spring, while parts of the north can be drier.",
       ["The summer after a strong El Niño has often seen heavy Yangtze River rain and flooding.",
        "Warmer winters are common in parts of the country."],
       ["1998: major Yangtze floods in the summer after the 1997–98 El Niño."],
       ("China Meteorological Administration", "https://www.cma.gov.cn/en/"), aliases=["China", "Chinese", "Yangtze"]),
    _c("japan", "Japan", "East Asia", ["392"], 36.5, 138.0, "warmer", "Winter (December–February)",
       "El Niño tends to bring warmer winters and cooler, wetter summers.",
       ["Milder winters mean less snow on the Sea of Japan side.", "Cool summers can affect rice growth."],
       [], ("Japan Meteorological Agency", "https://www.jma.go.jp/jma/indexe.html"), aliases=["Japan", "Japanese", "JMA"]),
    _c("south-korea", "South Korea", "East Asia", ["410"], 36.5, 128.0, "warmer", "Winter",
       "El Niño winters tend to be milder, with more rain or snow in some events.", [], [],
       ("Korea Meteorological Administration", "https://www.kma.go.kr/neng/index.do"), aliases=["South Korea", "Korea", "Korean"]),
    _c("taiwan", "Taiwan", "East Asia", ["158"], 23.7, 121.0, "mixed", "Winter and spring",
       "El Niño often brings a wetter winter and spring and can change the number of typhoons.", [], [],
       aliases=["Taiwan", "Taiwanese"]),

    # ---------------- Oceania ----------------
    _c("australia", "Australia", "Oceania", ["036"], -25.0, 134.0, "drier", "Winter–spring (June–November)",
       "El Niño often means below-average winter–spring rain in eastern Australia, more heat and higher bushfire risk.",
       ["Wheat and other winter crops in the east can see lower yields.",
        "Hotter days and lower rainfall increase bushfire danger in spring and summer.",
        "Snow seasons in the Alps are often poorer.",
        "The Indian Ocean Dipole also strongly influences Australian rainfall."],
       ["1982–83 and 2002: severe El Niño droughts in eastern Australia."],
       ("Bureau of Meteorology", "http://www.bom.gov.au/climate/enso/"),
       aliases=["Australia", "Australian", "BoM", "Queensland", "New South Wales"]),
    _c("new-zealand", "New Zealand", "Oceania", ["554"], -41.5, 172.5, "mixed", "Summer and winter",
       "El Niño tends to bring more westerly winds: wetter in the west, drier in the east, and cooler overall.",
       ["Eastern regions such as Canterbury and Hawke's Bay face a higher drought risk.",
        "Westerly winds bring more rain to the West Coast."],
       [], ("NIWA", "https://niwa.co.nz/climate"), aliases=["New Zealand", "Kiwi", "Canterbury"]),
    _c("fiji", "Fiji", "Pacific Islands", ["242"], -17.8, 178.0, "drier", "Wet season (November–April)",
       "El Niño tends to bring drought and a lower tropical cyclone risk near Fiji (risk moves east).",
       ["Sugarcane and water supplies are affected by drought."],
       ["1997–98: severe drought."], ("Fiji Meteorological Service", "https://www.met.gov.fj/"), aliases=["Fiji", "Fijian"]),
    _c("solomon-islands", "Solomon Islands", "Pacific Islands", ["090"], -9.6, 160.2, "drier", "Varies",
       "El Niño tends to bring drier conditions to the southwest Pacific.", [], [], aliases=["Solomon Islands"]),
    _c("vanuatu", "Vanuatu", "Pacific Islands", ["548"], -15.4, 166.9, "drier", "Wet season",
       "El Niño often brings drought, affecting water tanks and gardens.", [], [], aliases=["Vanuatu"]),
    _c("kiribati", "Kiribati", "Pacific Islands", [], 1.9, -157.4, "wetter", "Most of the year",
       "Central Pacific islands near the warm water get much more rain and higher sea levels during El Niño.",
       ["Heavy rain can cause flooding and contaminate water supplies.",
        "Warm water can bleach coral reefs."],
       [], aliases=["Kiribati", "Tarawa"]),

    # ---------------- South America ----------------
    _c("peru", "Peru", "South America", ["604"], -9.2, -75.0, "wetter", "December–April (coast)",
       "The north coast gets heavy rain, floods and landslides, and warm coastal water hurts the anchovy fishery.",
       ["Warm coastal water drives fish away, affecting the world's largest anchovy fishery and fishmeal exports.",
        "Heavy rain in normally dry coastal deserts causes floods, mudslides (huaicos) and disease outbreaks.",
        "The southern Andes highlands (around Lake Titicaca) can be drier.",
        "A 'coastal El Niño' can happen even when the central Pacific is not warm."],
       ["1982–83 and 1997–98: devastating floods.",
        "2017: coastal El Niño floods.",
        "2023: extreme coastal El Niño with floods and the country's worst recorded dengue outbreak."],
       ("SENAMHI", "https://www.senamhi.gob.pe/"),
       aliases=["Peru", "Peruvian", "Lima", "Piura", "Tumbes", "ENFEN", "anchovy", "anchoveta"]),
    _c("ecuador", "Ecuador", "South America", ["218"], -1.5, -78.5, "wetter", "December–May (coast)",
       "The coast gets heavy rain and floods; warm seas affect shrimp, fishing and the Galápagos.",
       ["Floods and landslides damage roads, homes and banana and cacao farms.",
        "Marine life in the Galápagos suffers when warm water cuts off nutrients."],
       ["1997–98: severe coastal flooding.", "2023: coastal El Niño rains."],
       ("INAMHI", "https://www.inamhi.gob.ec/"), aliases=["Ecuador", "Ecuadorian", "Guayaquil", "Galápagos", "Galapagos"]),
    _c("chile", "Chile", "South America", ["152"], -33.5, -71.0, "wetter", "Winter (June–August), central Chile",
       "Central Chile tends to get a wetter winter with more snow in the Andes.",
       ["More rain can ease drought but also cause floods and mudslides.",
        "Warm coastal waters can affect fisheries."],
       [], ("Dirección Meteorológica de Chile", "https://www.meteochile.gob.cl/"), aliases=["Chile", "Chilean", "Santiago"]),
    _c("colombia", "Colombia", "South America", ["170"], 4.5, -74.0, "drier", "Most of the year",
       "El Niño tends to bring drier, hotter weather, forest fires and stress on hydropower and water supply.",
       ["Colombia relies heavily on hydropower, so low reservoirs can strain electricity supply.",
        "Coffee and other crops are affected by heat and drought."],
       [], ("IDEAM", "https://www.ideam.gov.co/"), aliases=["Colombia", "Colombian", "Bogotá", "Bogota"]),
    _c("venezuela", "Venezuela", "South America", ["862"], 7.0, -66.0, "drier", "Most of the year",
       "El Niño tends to bring drought that lowers the Guri reservoir and strains electricity supply.", [], [],
       aliases=["Venezuela", "Venezuelan"]),
    _c("brazil", "Brazil", "South America", ["076"], -10.0, -52.0, "mixed", "Varies by region",
       "The Amazon and northeast tend to be drier, with fire and river drought; the south tends to be wetter, with floods.",
       ["Low Amazon river levels can cut off river transport and harm wildlife.",
        "Drought in the northeast affects farming and water supply.",
        "Heavy rain in southern Brazil (such as Rio Grande do Sul) can cause major floods."],
       ["2023: record-low Amazon river levels during El Niño and a hot Atlantic.",
        "2023–24: severe floods in Rio Grande do Sul."],
       ("INMET", "https://portal.inmet.gov.br/"), aliases=["Brazil", "Brazilian", "Amazon", "Rio Grande do Sul", "São Paulo"]),
    _c("argentina", "Argentina", "South America", ["032"], -34.0, -64.0, "wetter", "Spring–summer (October–March)",
       "El Niño tends to bring more rain to the Pampas and northeast, often helping crops but sometimes causing floods.",
       ["Soybean, corn and wheat harvests often benefit after dry years.",
        "Flooding risk rises along the Paraná and Uruguay rivers."],
       [], ("Servicio Meteorológico Nacional", "https://www.smn.gob.ar/"), aliases=["Argentina", "Argentine", "Pampas", "Buenos Aires"]),
    _c("uruguay", "Uruguay", "South America", ["858"], -32.8, -56.0, "wetter", "Spring–summer",
       "El Niño tends to bring above-normal rain and river flooding.", [], [], aliases=["Uruguay", "Uruguayan"]),
    _c("paraguay", "Paraguay", "South America", ["600"], -23.4, -58.4, "wetter", "Spring–summer",
       "El Niño tends to bring heavy rain and floods along the Paraguay River.", [], [], aliases=["Paraguay", "Paraguayan"]),
    _c("bolivia", "Bolivia", "South America", ["068"], -16.5, -64.7, "mixed", "Wet season (December–March)",
       "The Altiplano highlands tend to be drier while the eastern lowlands can flood.", [], [], aliases=["Bolivia", "Bolivian"]),

    # ---------------- Central & North America ----------------
    _c("panama", "Panama", "Central America", ["591"], 8.5, -80.0, "drier", "Wet season (May–December)",
       "El Niño tends to bring a weaker rainy season, which can lower the lakes that feed the Panama Canal.",
       ["Less rain means less fresh water to operate the canal locks, so ship transits and depths may be limited.",
        "Water supply for Panama City shares the same lakes."],
       ["2023–24: drought tied to El Niño forced the Panama Canal to cut daily transits and draft limits."],
       aliases=["Panama", "Panama Canal", "Panamanian"]),
    _c("costa-rica", "Costa Rica", "Central America", ["188"], 10.0, -84.0, "drier", "Wet season (Pacific side)",
       "The Pacific side tends to be drier while the Caribbean side can be wetter.", [], [], aliases=["Costa Rica"]),
    _c("nicaragua", "Nicaragua", "Central America", ["558"], 12.9, -85.0, "drier", "Wet season",
       "Part of the Central American 'Dry Corridor', where El Niño tends to bring drought and crop losses.", [], [],
       aliases=["Nicaragua"]),
    _c("honduras", "Honduras", "Central America", ["340"], 14.8, -86.6, "drier", "Wet season",
       "El Niño tends to bring drought in the Dry Corridor, hurting maize and bean crops and food security.", [], [],
       aliases=["Honduras", "Honduran"]),
    _c("el-salvador", "El Salvador", "Central America", ["222"], 13.8, -88.9, "drier", "Wet season",
       "El Niño tends to bring rainfall deficits and crop losses for small farmers.", [], [], aliases=["El Salvador"]),
    _c("guatemala", "Guatemala", "Central America", ["320"], 15.5, -90.3, "drier", "Wet season",
       "El Niño tends to cause drought in the Dry Corridor, crop failures and hunger.",
       ["Subsistence maize and bean farmers are most affected."],
       ["2014–16: El Niño-linked drought in the Dry Corridor."], aliases=["Guatemala", "Guatemalan"]),
    _c("mexico", "Mexico", "North America", ["484"], 23.6, -102.5, "mixed", "Summer drier, winter wetter (north)",
       "Summers tend to be drier in the south and centre; winters tend to be wetter in the north.",
       ["Fewer Atlantic hurricanes but more eastern Pacific hurricanes in El Niño years.",
        "Drought in the summer rainy season can affect water reservoirs and crops."],
       [], ("Servicio Meteorológico Nacional (CONAGUA)", "https://smn.conagua.gob.mx/"), aliases=["Mexico", "Mexican"]),
    _c("united-states", "United States", "North America", ["840"], 39.5, -98.5, "mixed", "Winter (December–March)",
       "The southern tier (California to Florida) tends to be wetter and cooler; the north tends to be warmer and drier.",
       ["Wetter winters in the southern states can bring flooding and storms.",
        "The northern states and Ohio Valley often have milder winters with less snow.",
        "El Niño usually suppresses Atlantic hurricanes and boosts eastern and central Pacific hurricanes."],
       ["1997–98: heavy winter storms in California and the southern US."],
       ("NOAA Climate Prediction Center", "https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/"),
       aliases=["United States", "U.S.", "US", "America", "American", "California", "Florida", "Texas", "NOAA"]),
    _c("canada", "Canada", "North America", ["124"], 56.0, -106.0, "warmer", "Winter",
       "El Niño winters tend to be warmer than normal in western and central Canada, with less snow.", [], [],
       ("Environment and Climate Change Canada", "https://weather.gc.ca/"), aliases=["Canada", "Canadian"]),

    # ---------------- Africa ----------------
    _c("south-africa", "South Africa", "Southern Africa", ["710"], -29.0, 25.0, "drier", "Summer rains (November–March)",
       "El Niño tends to bring below-normal summer rain, heat and drought, especially in the north and east.",
       ["Maize harvests and livestock are hit by drought.", "Water restrictions become more likely."],
       ["2015–16: severe drought.", "2024: very dry, hot February during El Niño."],
       ("South African Weather Service", "https://www.weathersa.co.za/"), aliases=["South Africa", "South African"]),
    _c("zimbabwe", "Zimbabwe", "Southern Africa", ["716"], -19.0, 29.8, "drier", "Rainy season (November–March)",
       "El Niño tends to bring drought, poor maize harvests and low water at Lake Kariba.",
       ["Food insecurity rises when the maize harvest fails.",
        "Lower Kariba levels cut hydropower and cause power cuts."],
       ["2024: national drought disaster declared during El Niño."], aliases=["Zimbabwe", "Zimbabwean", "Kariba"]),
    _c("zambia", "Zambia", "Southern Africa", ["894"], -13.5, 27.8, "drier", "Rainy season (November–March)",
       "El Niño tends to bring drought; Zambia relies on hydropower from Kariba and Kafue.",
       ["Maize crop losses threaten food security.", "Long daily power cuts when reservoirs run low."],
       ["2024: drought declared a national disaster; Kariba hydropower output collapsed."],
       aliases=["Zambia", "Zambian", "Kariba"]),
    _c("malawi", "Malawi", "Southern Africa", ["454"], -13.3, 34.3, "drier", "Rainy season (November–March)",
       "El Niño tends to bring drought in the south and poorer maize harvests.", [],
       ["2024: state of disaster declared over El Niño drought."], aliases=["Malawi"]),
    _c("mozambique", "Mozambique", "Southern Africa", ["508"], -18.0, 35.0, "drier", "Rainy season (south and centre)",
       "El Niño tends to bring drought in the south and centre; the north can be wetter.", [], [], aliases=["Mozambique"]),
    _c("botswana", "Botswana", "Southern Africa", ["072"], -22.3, 24.7, "drier", "Rainy season",
       "El Niño tends to bring drought, affecting cattle grazing and water supply.", [], [], aliases=["Botswana"]),
    _c("namibia", "Namibia", "Southern Africa", ["516"], -22.0, 17.0, "drier", "Rainy season",
       "El Niño tends to bring drought and food shortages.", [], [], aliases=["Namibia", "Namibian"]),
    _c("lesotho", "Lesotho", "Southern Africa", ["426"], -29.6, 28.2, "drier", "Rainy season",
       "El Niño tends to bring drought, poorer harvests and food insecurity.", [], [], aliases=["Lesotho"]),
    _c("eswatini", "Eswatini", "Southern Africa", ["748"], -26.5, 31.5, "drier", "Rainy season",
       "El Niño tends to bring drought affecting maize and sugarcane.", [], [], aliases=["Eswatini", "Swaziland"]),
    _c("kenya", "Kenya", "East Africa", ["404"], 0.5, 37.9, "wetter", "Short rains (October–December)",
       "El Niño tends to bring heavy 'short rains', floods and landslides, especially with a positive Indian Ocean Dipole.",
       ["Floods displace people and damage roads and farms.",
        "Waterborne diseases such as cholera and mosquito-borne diseases such as Rift Valley fever can increase."],
       ["1997–98: severe El Niño floods.", "2023: major floods with El Niño and a strong positive Indian Ocean Dipole."],
       ("Kenya Meteorological Department", "https://meteo.go.ke/"), aliases=["Kenya", "Kenyan", "Nairobi"]),
    _c("somalia", "Somalia", "East Africa", ["706"], 5.2, 46.2, "wetter", "Deyr rains (October–December)",
       "El Niño tends to bring heavy October–December rains and river floods along the Juba and Shabelle.",
       ["Floods can follow years of drought, destroying crops and displacing many people."],
       ["2023: severe flooding after a historic drought."], aliases=["Somalia", "Somali"], map_names=["Somaliland"]),
    _c("ethiopia", "Ethiopia", "East Africa", ["231"], 9.1, 40.5, "mixed", "Kiremt (June–September) and October–December",
       "The main June–September rains in the north and centre tend to be weaker, while the south and east can be wetter late in the year.",
       ["Weak kiremt rains have led to drought and food shortages in past El Niño years."],
       ["2015: severe drought during a strong El Niño."], aliases=["Ethiopia", "Ethiopian"]),
    _c("tanzania", "Tanzania", "East Africa", ["834"], -6.4, 34.9, "wetter", "Short rains (October–December), north",
       "El Niño tends to bring heavy rain and floods to northern and coastal Tanzania.", [], [],
       aliases=["Tanzania", "Tanzanian"]),
    _c("uganda", "Uganda", "East Africa", ["800"], 1.4, 32.3, "wetter", "September–December",
       "El Niño tends to bring above-normal rain, floods and landslides.", [], [], aliases=["Uganda", "Ugandan"]),
]

BY_SLUG = {c["slug"]: c for c in COUNTRIES}


# Worldwide impact themes; `keywords` also tag news articles (see news.py).
THEMES: list[dict[str, Any]] = [
    {"id": "drought", "icon": "🏜️", "title": "Drought & fires",
     "text": "Southeast Asia, Australia, India, southern Africa, Central America and northern South America often get drier. "
             "Drought brings crop losses, water shortages and wildfires, such as Indonesia's peat fires.",
     "keywords": ["drought", "dry spell", "dry", "wildfire", "fire", "haze", "rainfall deficit", "water shortage",
                  "sequía", "seca", "kekeringan", "sécheresse", "干ばつ", "सूखा"]},
    {"id": "floods", "icon": "🌊", "title": "Floods & heavy rain",
     "text": "Coastal Peru and Ecuador, East Africa, southern Brazil, Argentina and the southern United States often get more rain, "
             "leading to floods and landslides.",
     "keywords": ["flood", "floods", "flooding", "heavy rain", "landslide", "mudslide", "inundación", "lluvias", "huaico",
                  "enchente", "chuva", "banjir", "inondation", "洪水", "बाढ़"]},
    {"id": "heat", "icon": "🌡️", "title": "Heat & global temperature",
     "text": "El Niño releases ocean heat into the air, so global average temperature usually rises during and after an event. "
             "Record-warm years often follow strong El Niño events, such as 1998, 2016 and 2024.",
     "keywords": ["heat", "heatwave", "record temperature", "hottest", "warmest", "global temperature", "calor",
                  "ola de calor", "panas", "canicule", "猛暑", "गर्मी", "लू"]},
    {"id": "food", "icon": "🌾", "title": "Food & farming",
     "text": "Harvests of rice, wheat, maize, palm oil, sugar, coffee and cocoa can drop in affected regions, "
             "which can raise food prices and hunger.",
     "keywords": ["crop", "crops", "harvest", "rice", "wheat", "maize", "corn", "sugar", "coffee", "cocoa", "palm oil",
                  "farmers", "food prices", "food security", "kharif", "agricultura", "cosecha", "arroz", "pertanian",
                  "beras", "récolte", "農業", "फसल", "किसान"]},
    {"id": "health", "icon": "🩺", "title": "Health",
     "text": "Floods and heat can spread diseases such as dengue, malaria, cholera and diarrhoea, "
             "and drought brings malnutrition.",
     "keywords": ["dengue", "malaria", "cholera", "disease", "outbreak", "health", "malnutrition", "hunger", "salud",
                  "saúde", "kesehatan", "santé", "डेंगू"]},
    {"id": "oceans", "icon": "🐠", "title": "Oceans, fisheries & coral",
     "text": "Warm water drives fish away from Peru and Ecuador and can bleach coral reefs around the world.",
     "keywords": ["coral", "bleaching", "fishery", "fisheries", "fishing", "anchovy", "anchoveta", "marine", "ocean heat",
                  "sea level", "pesca", "peixe", "ikan", "corail", "サンゴ"]},
    {"id": "economy", "icon": "⚡", "title": "Economy, energy & shipping",
     "text": "Drought can cut hydropower, raise electricity and commodity prices, and limit shipping, as when the "
             "Panama Canal restricted transits in 2023–24.",
     "keywords": ["economy", "economic", "inflation", "prices", "market", "hydropower", "electricity", "power cuts",
                  "load shedding", "shipping", "canal", "insurance", "GDP", "economía", "energía", "economia",
                  "energia", "ekonomi", "listrik", "économie", "経済", "महंगाई", "बिजली"]},
    {"id": "storms", "icon": "🌀", "title": "Hurricanes & typhoons",
     "text": "El Niño usually suppresses Atlantic hurricanes and boosts hurricanes and typhoons in the central and eastern Pacific.",
     "keywords": ["hurricane", "typhoon", "cyclone", "tropical storm", "huracán", "tufão", "topan", "ouragan", "台風", "चक्रवात"]},
    {"id": "forecast", "icon": "🔭", "title": "Forecasts & science",
     "text": "Weather agencies watch the Pacific weekly and issue El Niño watches, alerts and advisories months ahead.",
     "keywords": ["forecast", "outlook", "advisory", "watch", "alert", "NOAA", "WMO", "BoM", "IMD", "PAGASA", "BMKG",
                  "model", "prediction", "probability", "chance", "pronóstico", "previsão", "prakiraan", "prévision",
                  "予測", "पूर्वानुमान"]},
]


def _keyword_pattern(words: list[str]) -> re.Pattern:
    # Word boundaries for Latin-script words; plain substring for other scripts.
    parts = [rf"\b{re.escape(w)}\b" if w.isascii() else re.escape(w) for w in words]
    return re.compile("|".join(parts), re.IGNORECASE)


_THEME_PATTERNS = [(t["id"], _keyword_pattern(t["keywords"])) for t in THEMES]
_COUNTRY_PATTERNS = [(c["slug"], _keyword_pattern(c["aliases"])) for c in COUNTRIES if c["aliases"]]


def classify_themes(text: str) -> list[str]:
    return [tid for tid, pattern in _THEME_PATTERNS if pattern.search(text)]


def detect_countries(text: str) -> list[str]:
    found = []
    for slug, pattern in _COUNTRY_PATTERNS:
        if slug == "united-states":
            # "US"/"America" are ambiguous; only count clear US references.
            if re.search(r"\bU\.S\.|\bUnited States\b|\bCalifornia\b|\bFlorida\b|\bTexas\b", text):
                found.append(slug)
            continue
        if pattern.search(text):
            found.append(slug)
    return found


def public_data() -> dict[str, Any]:
    """Everything the page needs to draw and describe the impacts."""
    return {"effects": EFFECTS, "countries": COUNTRIES, "themes": [
        {k: v for k, v in t.items() if k != "keywords"} for t in THEMES], "sources": SOURCES}
