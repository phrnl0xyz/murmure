// GPT-Live en délégation client : on envoie chaque phrase en « commentary » et on mesure le premier son et le texte dit.
const KEY = process.env.OPENAI_API_KEY;
const phrases = [
  "Vigilance rouge : Haute-Corse.",
  "Score. PSG 2, OM 1.",
  "Marie Dupont, maire de Bastia.",
  "Bus 63, direction Gare de Lyon, devant.",
  "Affiche : Demain, une gare plus fluide, à droite.",
  "Tu es en terrasse, un tram à droite.",
  "Flash info. Routes coupées en Corse-du-Sud.",
  "Verre de bière VEGA, devant.",
  "Panneau : trottoir fermé, devant.",
  "BRUNO. Banque 200 euros.",
];
const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${KEY}` } });
let i = -1, sentAt = 0, first = null, said = "", results = [], idleTimer = null;
function next() {
  if (i >= 0) results.push({ attendu: phrases[i], dit: said.trim(), premierSon: first ? first - sentAt : null });
  i++; said = ""; first = null;
  if (i >= phrases.length) return finish();
  sentAt = Date.now();
  ws.send(JSON.stringify({ type: "session.commentary.append", delegation_id: null, content: phrases[i] }));
  clearTimeout(idleTimer); idleTimer = setTimeout(next, 7000);
}
function finish() {
  for (const r of results) console.log(`${String(r.premierSon ?? "—").padStart(5)} ms | attendu ${JSON.stringify(r.attendu)}\n         | dit     ${JSON.stringify(r.dit)}`);
  try { ws.send(JSON.stringify({ type: "session.close" })); } catch {}
  setTimeout(() => process.exit(0), 500);
}
ws.onopen = () => ws.send(JSON.stringify({ type: "session.start", session: {
  model: "gpt-live-1",
  instructions: "Tu es la voix de Murmure, en français. Tu lis à une personne aveugle des informations courtes. Dis chaque information telle quelle, sans rien ajouter, sans saluer, sans question.",
  audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } },
  delegation: { type: "client" },
} }));
ws.onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (!globalThis.__seen) globalThis.__seen = new Set();
  if (!globalThis.__seen.has(e.type)) { globalThis.__seen.add(e.type); console.log("événement", e.type); }
  if (e.type === "error") console.log("erreur", JSON.stringify(e.error).slice(0, 200));
  if (e.type === "session.started") {
    // Flux de silence en temps réel (100 ms de PCM 24 kHz) : l'horloge de la session avance.
    const silence = Buffer.alloc(4800).toString("base64");
    setInterval(() => { try { ws.send(JSON.stringify({ type: "session.input_audio.append", audio: silence })); } catch {} }, 100);
    setTimeout(next, 500);
  }
  if (e.type === "session.output_audio.delta" && !first) {
    // Premier morceau réellement audible (le flux contient aussi du silence).
    const b = Buffer.from(e.delta, "base64");
    let peak = 0;
    for (let k = 0; k + 1 < b.length; k += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(k)));
    if (peak > 1500) first = Date.now();
  }
  if (e.type === "session.output_transcript.delta") {
    said += e.delta;
    clearTimeout(idleTimer); idleTimer = setTimeout(next, 2500); // texte fini depuis 2,5 s : phrase suivante

  }
};
ws.onerror = (e) => console.log("erreur ws", e.message ?? e);
ws.onclose = (e) => console.log("fermé", e.code, e.reason);
setTimeout(finish, 100000);
