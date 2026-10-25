"""Bilan d'une séance de Murmure à partir de debug/journal.jsonl.

Usage : python3 scripts/seance.py            -> dernière séance
        python3 scripts/seance.py 17-43-00   -> séance commencée après cette heure (UTC, HH-MM-SS)
"""
import json, re, statistics as st, sys
from pathlib import Path

J = Path(__file__).resolve().parent.parent / "debug" / "journal.jsonl"
rows = [json.loads(l) for l in open(J)]
for r in rows:
    r["h"] = r["t"][11:19]
start_marks = [i for i, r in enumerate(rows) if r["kind"] == "telephone" and "Murmure démarre" in r["data"]["event"] or (r["kind"] == "telephone" and "Mode démonstration" in r["data"]["event"])]
if len(sys.argv) > 1:
    i0 = next(i for i, r in enumerate(rows) if r["h"] >= sys.argv[1])
else:
    i0 = start_marks[-1] if start_marks else 0
rows = rows[i0:]
end = next((i for i, r in enumerate(rows) if r["kind"] == "telephone" and "Murmure arrêté" in r["data"]["event"]), len(rows))
rows = rows[: end + 1]

tel = [r for r in rows if r["kind"] == "telephone"]
juges = [r for r in rows if r["kind"] == "juge"]
said = [r for r in tel if r["data"]["event"].startswith("dit :")]
first = {}
for r in tel:
    e = r["data"]["event"]
    if e.startswith("premier son"):
        m = re.match(r"([0-9.]+) s après l'image : (.*)", r["data"].get("detail") or "")
        if m: first[m[2]] = float(m[1])
drops = {}
for r in tel:
    e = r["data"]["event"]
    if e.startswith("tu :") and "Rien de nouveau" not in e:
        why = e[5:].split("«")[0].strip(" :")
        drops.setdefault(why, []).append((r["h"], e[5:120]))
errors = [r for r in tel if r["data"]["event"].startswith(("erreur", "son : voix OpenAI en échec", "son : flux", "caméra"))]
mode = "rue" if any("autour de moi" in r["data"]["event"].lower() for r in tel) else "écran"

print(f"Séance {rows[0]['h']} → {rows[-1]['h']} UTC, mode {mode}")
print(f"Images jugées : {len(juges)} | phrases dites : {len(said)} | écartées : {sum(len(v) for v in drops.values())}")
lat = list(first.values())
if lat:
    print(f"Premier son : médiane {st.median(lat):.1f} s, min {min(lat):.1f} s, max {max(lat):.1f} s")
print("\nCE QUI A ÉTÉ DIT")
for r in said:
    t = r["data"]["event"][6:]
    print(f"  {r['h']}  {first.get(t, 0):4.1f} s  {t}")
print("\nÉCARTÉ, PAR RAISON")
for why, lst in sorted(drops.items(), key=lambda x: -len(x[1])):
    print(f"  {len(lst):3}  {why}")
    for h, e in lst[:4]:
        print(f"        {h} {e}")

# Infos ratées : le juge voyait une info importante, et rien n'a été dit dans les 8 s.
said_t = [r["t"] for r in said]
def secs(t): h, m, s = t[11:19].split("-"); return int(h) * 3600 + int(m) * 60 + int(s)
missed = []
for r in juges:
    d = r["data"]
    if d.get("important", 0) >= 0.8 and d.get("nature") not in ("rien",) and d.get("teleVisible", 1) >= 0.5:
        if not any(0 <= secs(t) - secs(r["t"]) <= 8 for t in said_t):
            missed.append(r)
print(f"\nINFOS RATÉES (juge ≥ 0,8, rien dit dans les 8 s) : {len(missed)}")
for r in missed[:12]:
    print(f"  {r['h']}  {r['data'].get('nature'):18} {r.get('file')}")

# Longs silences
times = sorted([secs(r["t"]) for r in said])
gaps = [(b - a) for a, b in zip(times, times[1:]) if b - a > 30]
print(f"\nSilences de plus de 30 s entre deux phrases : {len(gaps)} {gaps[:8]}")
print(f"\nERREURS : {len(errors)}")
for r in errors[:10]:
    print(f"  {r['h']}  {r['data']['event'][:90]} | {(r['data'].get('detail') or '')[:80]}")
