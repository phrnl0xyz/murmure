"""Banc d'essai de Murmure : rejoue des images de vrais essais et mesure chaque réglage du conteur.

Usage : python3 scripts/banc.py CODE   (serveur lancé, MURMURE_DEBUG=1)
Mesure pour chaque réglage : temps du conteur, note du vérificateur (exactitude), nombre de mots.
"""
import base64, json, statistics as st, sys, time, urllib.request
from pathlib import Path

CODE = sys.argv[1]
ROOT = Path(__file__).resolve().parent.parent
DEBUG = ROOT / "debug"

def post(path, body):
    t = time.time()
    req = urllib.request.Request("http://localhost:3000" + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "x-murmure-code": CODE})
    try:
        out = json.loads(urllib.request.urlopen(req, timeout=90).read())
    except urllib.error.HTTPError as e:
        out = {"error": e.read().decode()[:200]}
    return out, (time.time() - t) * 1000

# Jeu d'images : celles où le juge voulait parler, plus quelques scènes, réparties sur tous les essais.
rows = [json.loads(l) for l in open(DEBUG / "journal.jsonl")]
juges = [r for r in rows if r["kind"] == "juge" and r.get("file") and (DEBUG / r["file"]).exists()]
utiles = [r for r in juges if r["data"].get("important", 0) >= 0.7 and r["data"].get("teleVisible", 0) >= 0.5]
scenes = [r for r in juges if r["data"].get("nature") == "scene" and r["data"].get("teleVisible", 0) >= 0.5]
def spread(lst, n):
    return [lst[i * len(lst) // n] for i in range(n)] if len(lst) >= n else lst
images = spread(utiles, 9) + spread(scenes, 3)

CONFIGS = [
    ("Sol, actuel", {}),
    ("Sol, réflexion basse", {"effort": "low"}),
    ("Sol, réflexion basse, image légère", {"effort": "low", "detail": "low"}),
    ("GPT-5.4 mini", {"model": "gpt-5.4-mini", "effort": "low"}),
    ("GPT-5.4 nano", {"model": "gpt-5.4-nano", "effort": "low"}),
    ("GPT-4.1 mini", {"model": "gpt-4.1-mini"}),
    ("GPT-5.6 Sol", {"model": "gpt-5.6-sol", "effort": "low"}),
]
only = sys.argv[2:]  # optionnel : noms de réglages à tester
results = {}
for name, bench in CONFIGS:
    if only and name not in only:
        continue
    ms, notes, mots, textes = [], [], [], []
    for r in images:
        img = "data:image/jpeg;base64," + base64.b64encode((DEBUG / r["file"]).read_bytes()).decode()
        d, t = post("/api/describe", {"image": img, "recent": [], "bench": {"model": None, **bench} if "model" not in bench else bench})
        if "error" in d:
            textes.append("ERREUR " + d["error"][:80]); continue
        v, _ = post("/api/verify", {"image": img, "texte": d["texte"]})
        ms.append(d["ms"]); notes.append(v.get("conforme", 0)); mots.append(len(d["texte"].split())); textes.append(d["texte"])
    results[name] = {"ms": ms, "notes": notes, "mots": mots, "textes": textes}
    if ms:
        bonnes = sum(1 for n in notes if n >= 0.7)
        print(f"{name:38} conteur médiane {st.median(ms):5.0f} ms  max {max(ms):5.0f} ms | justes {bonnes}/{len(notes)} | mots {st.median(mots):.0f}", flush=True)
    else:
        print(f"{name:38} {textes[:1]}", flush=True)
(DEBUG / "banc.json").write_text(json.dumps({"images": [r["file"] for r in images], "results": results}, ensure_ascii=False, indent=1))
