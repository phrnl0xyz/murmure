"""Guet en direct d'une séance : un point par minute, les erreurs tout de suite, et la fin de séance."""
import json, re, statistics as st, sys, time
from pathlib import Path

J = Path(__file__).resolve().parent.parent / "debug" / "journal.jsonl"
f = open(J); f.seek(0, 2)
said, drops, lat, started, last_report, last_said = 0, 0, [], False, time.time(), ""
def out(s): print(s, flush=True)
while True:
    line = f.readline()
    if not line:
        time.sleep(0.5)
        if started and time.time() - last_report >= 60:
            m = f"médiane {st.median(lat):.1f} s" if lat else "aucune"
            out(f"Point : {said} dites, {drops} écartées, premier son {m}. Dernière : {last_said}")
            last_report = time.time()
        continue
    try: r = json.loads(line)
    except Exception: continue
    if r["kind"] != "telephone": continue
    e = r["data"]["event"]; d = r["data"].get("detail") or ""
    if "Murmure démarre" in e or "Mode démonstration" in e:
        started, said, drops, lat, last_report = True, 0, 0, [], time.time()
        out(f"Séance démarrée : {e}")
    elif e.startswith("dit :"):
        said += 1; last_said = e[6:]
    elif e.startswith("tu :") and "Rien de nouveau" not in e:
        drops += 1
    elif e.startswith("premier son"):
        m = re.match(r"([0-9.]+)", d)
        if m: lat.append(float(m[1]))
    elif e.startswith("erreur") or "échec" in e or "caméra" in e:
        out(f"Problème : {e[:100]} | {d[:80]}")
    elif "Murmure arrêté" in e and started:
        out(f"Séance arrêtée : {said} dites, {drops} écartées.")
        sys.exit(0)
