"""Fluidité de la dernière séance : phrases dites, premier son, blancs entre deux phrases."""
import json, re, statistics as st
from pathlib import Path
J = Path(__file__).resolve().parent.parent / "debug" / "journal.jsonl"
rows = [json.loads(l) for l in open(J)]
idx = max(i for i, r in enumerate(rows) if r["kind"] == "telephone" and ("Murmure démarre" in r["data"]["event"] or "Mode démonstration" in r["data"]["event"]))
tel = [r for r in rows[idx:] if r["kind"] == "telephone"]
def s(t): return int(t[11:13]) * 3600 + int(t[14:16]) * 60 + int(t[17:19]) + int(t[20:23]) / 1000
said = [r for r in tel if r["data"]["event"].startswith("dit :")]
firsts = [r for r in tel if r["data"]["event"].startswith("premier son")]
ends = [r for r in tel if r["data"]["event"].startswith("son : voix jouée")]
lat = [float(re.match(r"([0-9.]+)", r["data"]["detail"])[1]) for r in firsts]
dur = s(tel[-1]["t"]) - s(tel[0]["t"])
print(f"durée {dur:.0f} s | phrases dites {len(said)} | premier son médiane {st.median(lat) if lat else 0:.1f} s (min {min(lat) if lat else 0:.1f}, max {max(lat) if lat else 0:.1f})")
starts = [s(r["t"]) for r in firsts]
gaps = []
for a in [s(r["t"]) for r in ends]:
    nxt = [b for b in starts if b > a]
    if nxt: gaps.append(round(min(nxt) - a, 1))
print("blancs entre deux phrases (s) :", gaps, "| médiane", st.median(gaps) if gaps else "-")
for r in said: print(" ", r["t"][11:19], r["data"]["event"][6:])
print("rien de nouveau ou écartées :", sum(1 for r in tel if r["data"]["event"].startswith("tu")))
print("erreurs :", [r["data"]["event"][:80] for r in tel if r["data"]["event"].startswith("erreur")][:5])
