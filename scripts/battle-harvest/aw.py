import re, time, urllib.parse, urllib.request, http.cookiejar

URL = "https://astrowars.games/About/BattleCalculator"
UA  = "Mozilla/5.0 (X11; Linux x86_64) battle-model-calibration/1.0"

class Client:
    def __init__(self):
        self.cj = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
        self.op.addheaders = [("User-Agent", UA)]
        self.token = None
        self.refresh()

    def refresh(self):
        html = self.op.open(URL, timeout=30).read().decode("utf-8", "replace")
        m = re.search(r'name="__RequestVerificationToken" type="hidden" value="([^"]+)"', html)
        self.token = m.group(1)

    def post(self, c, retries=3):
        body = [
            ("Defender[0]", c["d_de"]), ("Defender[1]", c["d_cr"]),
            ("Defender[2]", c["d_bs"]), ("Defender[3]", c["d_sb"]),
            ("Attacker[0]", c["a_de"]), ("Attacker[1]", c["a_cr"]),
            ("Attacker[2]", c["a_bs"]), ("Attacker[3]", 0),
            ("DefenderPhysicLevel", c["d_ph"]), ("AttackerPhysicLevel", c["a_ph"]),
            ("DefenderMathLevel", c["d_ma"]),   ("AttackerMathLevel", c["a_ma"]),
            ("DefenderPlayerLevel", c["d_pl"]), ("AttackerPlayerLevel", c["a_pl"]),
            ("DefenderRaceModAttack", c["d_ra"]),  ("AttackerRaceModAttack", c["a_ra"]),
            ("DefenderRaceModDefence", c["d_rd"]), ("AttackerRaceModDefence", c["a_rd"]),
            ("IsAllied", "true" if c["allied"] else "false"),
            ("DefenderId", ""), ("AttackerId", ""),
            ("CurrentDefenderId", ""), ("CurrentAttackerId", ""),
            ("__RequestVerificationToken", self.token),
        ]
        data = urllib.parse.urlencode(body).encode()
        last = None
        for i in range(retries):
            try:
                r = self.op.open(urllib.request.Request(URL, data=data), timeout=45)
                return r.read().decode("utf-8", "replace")
            except Exception as e:
                last = e
                time.sleep(1.5 * (i + 1))
                try: self.refresh()
                except Exception: pass
        raise last

NUM = r'([-+]?[\d.,]+)'

def _rowspans(html, anchor):
    """Return the <span> texts of the result row whose label targets `anchor`."""
    i = html.find(f'for="{anchor}"')
    if i < 0: return []
    tr_start = html.rfind("<tr", 0, i)
    tr_end   = html.find("</tr>", i)
    return re.findall(r"<span>([^<]*)</span>", html[tr_start:tr_end])

def _labelrow(html, label):
    m = re.search(r"<td>\s*" + re.escape(label) + r"\s*</td>(.*?)</tr>", html, re.S)
    if not m: return []
    return [re.sub(r"<[^>]+>", "", t).strip()
            for t in re.findall(r"<td>(.*?)</td>", m.group(1), re.S)]

def parse(html):
    o = {}
    for key, anchor in (("de", "Defender_Destroyer"), ("cr", "Defender_Cruiser"),
                        ("bs", "Defender_Battleship"), ("sb", "Starbase")):
        s = _rowspans(html, anchor)
        o[f"d_{key}_surv"] = s[0] if len(s) > 0 else None
        if key != "sb":
            o[f"a_{key}_surv"] = s[1] if len(s) > 1 else None
    win = _labelrow(html, "Chance to win")
    o["d_win"] = win[0].rstrip("%") if len(win) > 0 else None
    o["a_win"] = win[2].rstrip("%") if len(win) > 2 else None
    cv = _labelrow(html, "Combat value (lost)")
    for side, idx in (("d", 0), ("a", 2)):
        if len(cv) > idx:
            m = re.match(r"([\d,]+)\s*\(-([\d,]+)\)", cv[idx])
            if m:
                o[f"{side}_cv"]   = m.group(1).replace(",", "")
                o[f"{side}_cvlost"] = m.group(2).replace(",", "")
    xp = _labelrow(html, "XP on victory")
    o["d_xp"] = xp[0].replace(",", "") if len(xp) > 0 else None
    o["a_xp"] = xp[2].replace(",", "") if len(xp) > 2 else None
    return o
