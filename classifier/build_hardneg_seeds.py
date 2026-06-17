"""Build a hard-negative seed URL list for the CLEAN class — pages with a target
category's VOCABULARY but a clean page's STRUCTURE (articles, marketing, news,
education). These are exactly the is-vs-about cases the v3 fusion model failed:
Wikipedia "Proxy server" -> proxy@1.00, nordvpn -> proxy@1.00. The model never
learned "topic words + article structure => clean" because the clean training set
was random popular domains. This injects that lesson.

Bulk article URLs come from the MediaWiki category-members API (real, current,
high-volume); topic-adjacent marketing/news/edu homepages are curated.

The live --suite URLs are EXCLUDED so re-running the suite stays an honest
generalization test (train on other topic articles, measure on the held-out few).

Run: python -m classifier.build_hardneg_seeds   ->  classifier/hardneg_seeds.txt
"""

from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "hardneg_seeds.txt"
API = "https://en.wikipedia.org/w/api.php"

# Categories whose ARTICLES carry topic vocabulary but encyclopedic structure.
WIKI_CATEGORIES = {
    "proxy": [
        "Proxy servers",
        "Internet censorship circumvention",
        "Virtual private networks",
        "Anonymity networks",
        "Internet censorship",
    ],
    "gambling": [
        "Online gambling",
        "Gambling",
        "Casino games",
        "Sports betting",
        "Poker",
        "Casinos",
        "Lottery",
        "Slot machines",
        "Online poker",
    ],
    "adult": [
        "Pornography",
        "Sex industry",
        "Human sexuality",
        "Adult entertainment",
    ],
    "games": [
        "Browser games",
        "Online games",
        "Video game genres",
        "Casual games",
        "Massively multiplayer online games",
    ],
}

# Topic-adjacent CLEAN domains (homepages). Vocabulary of the category, structure
# of a product/news/education site. ~50-200 per category so the model gets enough
# coverage to learn "topic words + clean structure => clean" rather than memorizing
# a handful. Suite domains are omitted (see EXCLUDE_DOMAINS) so the suite stays a
# held-out generalization test.
#
# NOT INCLUDED ON PURPOSE: genuine censorship-circumvention tools (Psiphon,
# Ultrasurf, Hola, Lantern, Tor-as-unblocker). Those are real proxy-bypass
# POSITIVES; labeling them clean would teach the model to wave actual unblockers
# through. Only commercial privacy VPNs + VPN editorial/review go in here.
_VPN = [
    # commercial privacy VPN product sites
    "expressvpn.com", "surfshark.com", "protonvpn.com", "proton.me",
    "privateinternetaccess.com", "cyberghostvpn.com", "mullvad.net", "tunnelbear.com",
    "windscribe.com", "ipvanish.com", "hide.me", "purevpn.com", "hotspotshield.com",
    "privadovpn.com", "atlasvpn.com", "privatevpn.com", "fastestvpn.com", "ivacy.com",
    "safervpn.com", "perfect-privacy.com", "airvpn.org", "ovpn.com", "azirevpn.com",
    "trust.zone", "vpnsecure.me", "goosevpn.com", "blackvpn.com", "cryptostorm.is",
    "vpn.ac", "vpnunlimited.com", "keepsolid.com", "zenmate.com", "betternet.co",
    "torguard.net", "slickvpn.com", "vpnarea.com", "hidemyass.com",
    # VPN/privacy editorial + review (heavy VPN vocab, clean prose)
    "vpnmentor.com", "comparitech.com", "top10vpn.com", "vpnranks.com", "bestvpn.com",
    "vpnoverview.com", "restoreprivacy.com", "security.org", "cloudwards.net",
    "safetydetectives.com", "proprivacy.com", "thebestvpn.com", "privacyaffairs.com",
    "wizcase.com", "cybernews.com", "vpnpro.com", "allthingssecured.com",
    "privacyguides.org", "privacytools.io", "vpncompare.co.uk", "vpnalert.com",
]
# News / regulator / responsible-gambling / B2B-trade press / help orgs ONLY.
# Casino REVIEW/AFFILIATE/promotion sites (casino.org, gambling.com, askgamblers,
# casino.guru, thepogg, lcb.org, bonusfinder, wizardofodds, gamblingsites,
# onlinegambling.com, americancasinoguide, bettingusa, pokerstrategy, oddschecker,
# casinomeister) are DELIBERATELY EXCLUDED: they funnel to operators and carry
# heavy casino CTAs, so labeling them clean would erode casino detection (this is
# what dragged bovada toward clean in round 1). For a school filter they are
# arguably blockable themselves — never training material for "clean".
_GAMBLING_NEWS = [
    "legalsportsreport.com", "gamblingnews.com", "vegasinsider.com",
    "covers.com", "gamblingcommission.gov.uk", "begambleaware.org", "ncpgambling.org",
    "gamblersanonymous.org", "sportshandle.com", "playusa.com",
    "vsin.com", "sportsbettingdime.com", "pokernews.com", "cardplayer.com",
    "calvinayre.com", "igamingbusiness.com", "sbcnews.co.uk", "gamblinginsider.com",
    "casinobeats.com", "egr.global", "twoplustwo.com", "gamblingtherapy.org",
    "responsiblegambling.org",
]
_GAMING_NEWS = [
    "ign.com", "polygon.com", "kotaku.com", "gamespot.com", "pcgamer.com",
    "eurogamer.net", "rockpapershotgun.com", "gamesradar.com", "destructoid.com",
    "nintendolife.com", "pushsquare.com", "purexbox.com", "vg247.com",
    "videogameschronicle.com", "thegamer.com", "gamerant.com", "dualshockers.com",
    "siliconera.com", "gematsu.com", "pocketgamer.com", "toucharcade.com",
    "gamedeveloper.com", "mmorpg.com", "massivelyop.com", "pcgamesn.com", "n4g.com",
    "metacritic.com", "opencritic.com", "howlongtobeat.com", "twinfinite.net",
    "gamingtrend.com", "hardcoregamer.com", "godisageek.com", "gfinityesports.com",
    "dotesports.com", "esportsinsider.com", "dexerto.com", "wccftech.com",
    "gameranx.com", "escapistmagazine.com", "gamingbolt.com", "gamesindustry.biz",
    "nintendoworldreport.com", "gamerevolution.com", "dsogaming.com", "gamepur.com",
]
_SEXUAL_HEALTH = [
    "scarleteen.com", "kidshealth.org", "bedsider.org", "sexinfoonline.com",
    "ashasexualhealth.org", "sexandu.ca", "goaskalice.columbia.edu", "sexetc.org",
    "amaze.org", "itsyoursexlife.com", "fpa.org.uk", "brook.org.uk", "avert.org",
    "guttmacher.org", "siecus.org", "advocatesforyouth.org", "thetrevorproject.org",
    "isna.org", "kinseyinstitute.org", "teenhealthsource.com", "loveisrespect.org",
    "rainn.org", "optionsforsexualhealth.org", "theline.org.au", "mayoclinic.org",
    "healthline.com", "webmd.com", "verywellhealth.com", "medicalnewstoday.com",
]
_EDU_INTERACTIVE = [
    "desmos.com", "geogebra.org", "brilliant.org", "code.org", "scratch.mit.edu",
    "typing.com", "mathplayground.com", "prodigygame.com", "ixl.com", "mathway.com",
    "photomath.com", "wolframalpha.com", "symbolab.com", "quizlet.com", "kahoot.com",
    "quizizz.com", "nearpod.com", "padlet.com", "wordwall.net", "education.com",
    "splashlearn.com", "starfall.com", "abcmouse.com", "duolingo.com", "memrise.com",
    "busuu.com", "sololearn.com", "codecademy.com", "freecodecamp.org", "w3schools.com",
    "replit.com", "tynker.com", "edpuzzle.com", "ck12.org", "phet.colorado.edu",
    "explorelearning.com", "mathigon.org", "deltamath.com", "albert.io",
    "gimkit.com", "blooket.com", "classdojo.com", "sumdog.com", "mathletics.com",
]
CURATED_DOMAINS = _VPN + _GAMBLING_NEWS + _GAMING_NEWS + _SEXUAL_HEALTH + _EDU_INTERACTIVE

# Exact suite titles to keep out of training so the suite stays held-out.
EXCLUDE_TITLES = {"Proxy server", "Online gambling", "Pornography"}
# Suite DOMAINS (and their content) kept out of seeds for the same reason.
EXCLUDE_DOMAINS = {
    "nordvpn.com", "vyprvpn.com", "strongvpn.com", "actionnetwork.com",
    "gameinformer.com", "plannedparenthood.org", "khanacademy.org",
    "coolmathgames.com", "coolmath.com", "espn.com", "bovada.lv", "4everproxy.com",
}

# Cap wiki articles per topic so one large category (Browser games has ~500)
# can't skew the hard-negative lesson and make the model shy on that category.
TOPIC_CAP = 250


def wiki_category_members(client: httpx.Client, category: str) -> list[str]:
    """Article (ns=0) page titles in a category, following continuation."""
    titles: list[str] = []
    cont: dict = {}
    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{category}",
            "cmtype": "page",
            "cmlimit": "500",
            "format": "json",
            **cont,
        }
        r = client.get(API, params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        for m in data.get("query", {}).get("categorymembers", []):
            titles.append(m["title"])
        if "continue" in data:
            cont = data["continue"]
        else:
            break
    return titles


def main() -> None:
    urls: list[str] = []
    seen: set[str] = set()

    def add(u: str) -> None:
        if u not in seen:
            seen.add(u)
            urls.append(u)

    # Wikimedia enforces a UA policy; a descriptive UA with a contact URL avoids 403.
    ua = "Mozilla/5.0 (compatible; fenceline-research-bot/1.0; +https://github.com/fenceline) httpx"
    with httpx.Client(headers={"User-Agent": ua}) as client:
        for topic, cats in WIKI_CATEGORIES.items():
            picked: list[str] = []
            for cat in cats:
                try:
                    titles = wiki_category_members(client, cat)
                except Exception as exc:
                    print(f"  [{topic}] Category:{cat} FAILED: {exc}")
                    continue
                for t in titles:
                    if t in EXCLUDE_TITLES:
                        continue
                    u = "https://en.wikipedia.org/wiki/" + t.replace(" ", "_")
                    if u not in seen and u not in picked:
                        picked.append(u)
                print(f"  [{topic}] Category:{cat}: {len(titles)} members")
            for u in picked[:TOPIC_CAP]:
                add(u)
            print(f"[{topic}] kept {min(len(picked), TOPIC_CAP)} of {len(picked)} article URLs")

    n_wiki = len(urls)
    n_curated = 0
    for d in CURATED_DOMAINS:
        if d in EXCLUDE_DOMAINS:
            continue
        u = f"https://{d}/"
        if u not in seen:
            add(u)
            n_curated += 1

    OUT.write_text("\n".join(urls) + "\n", encoding="utf-8")
    print(f"\nwrote {len(urls)} hard-negative seed URLs -> {OUT}")
    print(f"  ({n_curated} curated domains + {n_wiki} wiki articles)")
    print(f"  curated breakdown: VPN={len(_VPN)} gambling-news={len(_GAMBLING_NEWS)} "
          f"gaming-news={len(_GAMING_NEWS)} sexual-health={len(_SEXUAL_HEALTH)} "
          f"edu={len(_EDU_INTERACTIVE)}")


if __name__ == "__main__":
    main()
