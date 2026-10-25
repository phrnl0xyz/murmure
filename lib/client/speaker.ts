// La bouche de Murmure. Toutes les paroles passent par la voix OpenAI, jouée par un élément <audio>
// avec la session audio en mode « lecture » : le son sort même en mode silencieux.
// La voix du téléphone (speechSynthesis) ne sert qu'en secours : sur iPhone, elle peut être muette
// et perturber la caméra.

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };
type Language = "fr" | "en";

// 0,1 s de silence, pour débloquer le son pendant le geste de l'utilisateur.
const SILENCE = "data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RATE = 1.35; // lecture accélérée, la hauteur de la voix est conservée

export type AudioCheck = { ok: boolean; detail: string };
export type Spoken = { via: "openai" | "telephone"; error?: string };

export class Speaker {
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  /** Change à chaque arrêt : une voix demandée avant l'arrêt ne doit jamais jouer après. */
  private epoch = 0;
  /** Échecs du flux d'affilée : au deuxième, on repasse au fichier entier pour toute la séance. */
  private streamFailures = 0;
  busy = false;
  code = "";
  language: Language = "fr";
  /** Trace des événements audio, envoyée au Mac en mode réglage. */
  trace: (event: string, detail?: string) => void = () => {};

  /** À appeler dans le geste de l'utilisateur : obligatoire sur iPhone. */
  async unlock(): Promise<AudioCheck> {
    const nav = navigator as AudioSessionNavigator;
    try {
      if (nav.audioSession) nav.audioSession.type = "playback";
    } catch {}
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.setAttribute("playsinline", "");
      this.audio.preload = "auto";
    }
    try {
      // On oublie les écouteurs d'une phrase précédente, sinon la fin du silence la terminerait.
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.src = SILENCE;
      await this.audio.play();
      this.trace("son débloqué", nav.audioSession ? `session ${nav.audioSession.type}` : "pas de session audio");
      return { ok: true, detail: nav.audioSession ? "session audio en mode lecture" : "session audio non réglable sur ce navigateur" };
    } catch (e) {
      this.trace("déblocage du son refusé", e instanceof Error ? `${e.name} ${e.message}` : String(e));
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  stop() {
    this.epoch += 1;
    try {
      this.audio?.pause();
    } catch {}
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.busy = false;
  }

  /** Demande la voix d'une phrase. On peut l'appeler en avance, pendant la vérification. */
  async fetchVoice(text: string): Promise<Blob> {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-murmure-code": this.code },
      body: JSON.stringify({ texte: text, language: this.language }),
    });
    if (res.status !== 200) throw new Error(`voix OpenAI indisponible (${res.status})`);
    const blob = await res.blob();
    this.trace("voix reçue", `${blob.size} octets`);
    return blob;
  }

  /** Dit une phrase avec la voix OpenAI, déjà préparée ou non. Secours : voix du téléphone. */
  /**
   * Dit une phrase en flux : l'élément <audio> lit la voix au fur et à mesure qu'OpenAI la produit.
   * Gagne environ une seconde sur le chemin « fichier entier ». Secours : fichier entier, puis voix du téléphone.
   */
  /** Demande au serveur de préparer la voix tout de suite ; rend son identifiant (ou null). */
  async prepare(text: string): Promise<string | null> {
    try {
      const res = await fetch("/api/speak/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-murmure-code": this.code },
        body: JSON.stringify({ texte: text, language: this.language }),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { id?: string | null };
      return j.id ?? null;
    } catch {
      return null;
    }
  }

  async sayStream(text: string, onStart?: () => void, maxWait = 3500, preparedId?: string | null): Promise<Spoken> {
    const epoch = this.epoch;
    const audio = this.audio;
    if (!audio || this.streamFailures >= 2) return this.say(text, undefined, onStart);
    this.busy = true;
    try {
      await new Promise<void>((resolve, reject) => {
        let started = false;
        const guard = setTimeout(() => {
          if (!started) reject(new Error("voix trop lente à démarrer"));
        }, maxWait);
        const end = setTimeout(() => resolve(), 20000);
        audio.onplaying = () => {
          if (started) return;
          started = true;
          clearTimeout(guard);
          onStart?.();
        };
        audio.onended = () => {
          clearTimeout(guard);
          clearTimeout(end);
          this.trace("voix jouée (flux)", `${Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : "?"} s`);
          resolve();
        };
        audio.onerror = () => {
          clearTimeout(guard);
          clearTimeout(end);
          reject(new Error(`flux audio impossible, code ${audio.error?.code}`));
        };
        const id = preparedId ? `&id=${encodeURIComponent(preparedId)}` : "";
        audio.src = `/api/speak?k=${encodeURIComponent(this.code)}&t=${encodeURIComponent(text)}&language=${this.language}${id}`;
        audio.defaultPlaybackRate = RATE;
        audio.playbackRate = RATE;
        audio.play().catch((e) => {
          clearTimeout(guard);
          clearTimeout(end);
          reject(e);
        });
      });
      this.streamFailures = 0;
      return { via: "openai" };
    } catch (e) {
      audio.onplaying = null;
      this.streamFailures += 1;
      if (this.streamFailures === 2) this.trace("flux abandonné pour la séance", "retour au fichier entier");
      if (epoch !== this.epoch) return { via: "openai", error: "annulé" };
      const err = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      this.trace("flux en échec, fichier entier", err);
      this.busy = false;
      if (/trop lente/.test(err)) return { via: "openai", error: err }; // trop tard : on se tait plutôt que parler en retard
      return this.say(text, undefined, onStart);
    } finally {
      audio.onplaying = null;
      if (epoch === this.epoch) this.busy = false;
    }
  }

  /** Coupe la phrase en cours, pour laisser passer une info plus importante. */
  cut() {
    this.epoch += 1; // la phrase coupée ne doit pas libérer la voix de la suivante
    try {
      this.audio?.pause();
      this.audio?.dispatchEvent(new Event("ended"));
    } catch {}
  }

  async say(text: string, voice?: Promise<Blob>, onStart?: () => void): Promise<Spoken> {
    const epoch = this.epoch;
    this.busy = true;
    try {
      const blob = await (voice ?? this.fetchVoice(text));
      if (epoch !== this.epoch) return { via: "openai", error: "annulé par l'arrêt" };
      if (!this.audio) throw new Error("son non débloqué");
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(blob);
      const audio = this.audio;
      await new Promise<void>((resolve, reject) => {
        const guard = setTimeout(() => resolve(), 15000);
        audio.onended = () => {
          clearTimeout(guard);
          this.trace("voix jouée", `${audio.duration.toFixed(1)} s`);
          resolve();
        };
        audio.onerror = () => {
          clearTimeout(guard);
          reject(new Error(`lecture audio impossible, code ${audio.error?.code}`));
        };
        audio.src = this.url!;
        audio.defaultPlaybackRate = RATE;
        audio.playbackRate = RATE;
        audio
          .play()
          .then(() => onStart?.())
          .catch((e) => {
            clearTimeout(guard);
            reject(e);
          });
      });
      return { via: "openai" };
    } catch (e) {
      const err = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      if (epoch !== this.epoch) return { via: "openai", error: "annulé par l'arrêt" };
      this.trace("voix OpenAI en échec", err);
      await this.fallback(text);
      return { via: "telephone", error: err };
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }

  /** Voix du téléphone, seulement en secours. */
  private fallback(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.language === "en" ? "en-US" : "fr-FR";
      u.rate = 1.15;
      const preferred = this.language === "en" ? ["en-US", "en"] : ["fr-FR", "fr"];
      const voice = window.speechSynthesis.getVoices().find((v) => preferred.some((lang) => v.lang.toLowerCase().startsWith(lang.toLowerCase())));
      if (voice) u.voice = voice;
      const done = () => {
        clearTimeout(guard);
        resolve();
      };
      const guard = setTimeout(done, 4000);
      u.onend = done;
      u.onerror = done;
      window.speechSynthesis.speak(u);
    });
  }
}
