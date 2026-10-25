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
  /** Le serveur local peut préparer une voix ; Vercel utilise directement le flux. */
  preparationEnabled = false;
  /** Trace des événements audio, envoyée au Mac en mode réglage. */
  trace: (event: string, detail?: string) => void = () => {};

  /** À appeler dans le geste de l'utilisateur : obligatoire sur iPhone. */
  async unlock(): Promise<AudioCheck> {
    this.streamFailures = 0;
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

  private operation: AbortController | null = null;
  private preparations = new Set<AbortController>();
  private nextVoice: { key: string; ctrl: AbortController; voice: Promise<Blob | null>; timer: ReturnType<typeof setTimeout> } | null = null;

  private discardNextVoice() {
    if (!this.nextVoice) return;
    clearTimeout(this.nextVoice.timer);
    this.nextVoice.ctrl.abort();
    this.nextVoice = null;
  }

  private resetAudio() {
    if (this.audio) {
      this.audio.onplaying = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.onwaiting = null;
      this.audio.onstalled = null;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load(); // annule aussi un flux qui attend encore ses premiers octets
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  private interrupt() {
    this.epoch += 1;
    this.operation?.abort();
    this.operation = null;
    this.resetAudio();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.busy = false;
  }

  stop() {
    this.interrupt();
    this.discardNextVoice();
    for (const ctrl of this.preparations) ctrl.abort();
    this.preparations.clear();
  }

  private begin() {
    this.interrupt();
    const ctrl = new AbortController();
    this.operation = ctrl;
    this.busy = true;
    return { ctrl, epoch: this.epoch };
  }

  /** Même échéance pour le téléchargement, le flux et la voix de secours. */
  private beforeDeadline<T>(work: Promise<T>, ctrl: AbortController, deadline: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => { cleanup(); reject(ctrl.signal.reason); };
      const timer = setTimeout(() => ctrl.abort(new Error("voix trop lente à démarrer")), Math.max(0, deadline - Date.now()));
      const cleanup = () => { clearTimeout(timer); ctrl.signal.removeEventListener("abort", cancel); };
      ctrl.signal.addEventListener("abort", cancel, { once: true });
      if (ctrl.signal.aborted) cancel();
      work.then((value) => {
        cleanup();
        if (ctrl.signal.aborted) reject(ctrl.signal.reason);
        else if (Date.now() >= deadline) reject(new Error("voix trop lente à démarrer"));
        else resolve(value);
      }, (e) => { cleanup(); reject(e); });
    });
  }

  async fetchVoice(text: string, signal?: AbortSignal): Promise<Blob> {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-murmure-code": this.code },
      body: JSON.stringify({ texte: text, language: this.language }),
      signal,
    });
    if (res.status !== 200) throw new Error(`voix OpenAI indisponible (${res.status})`);
    const blob = await res.blob();
    this.trace("voix reçue", `${blob.size} octets`);
    return blob;
  }

  /** La préparation est annulable même si aucune lecture n'a encore commencé. */
  async prepare(text: string): Promise<string | null> {
    if (!this.preparationEnabled) {
      // Le navigateur conserve au plus une voix, sans dépendre d'une instance serveur.
      // On ne retarde jamais le premier son pour charger un fichier entier : seulement
      // pendant une lecture dont il reste au moins 1,5 s connues. Sinon, flux direct.
      const key = `${this.language}:${text}`;
      if (this.nextVoice?.key === key) return null;
      this.discardNextVoice();
      const remaining = this.audio ? (this.audio.duration - this.audio.currentTime) / RATE : 0;
      if (!this.busy || !Number.isFinite(remaining) || remaining < 1.5) return null;
      const ctrl = new AbortController();
      const timer = setTimeout(() => {
        ctrl.abort();
        if (this.nextVoice?.ctrl === ctrl) this.nextVoice = null;
      }, 3500);
      const voice = this.fetchVoice(text, ctrl.signal).then(blob => ctrl.signal.aborted ? null : blob, () => null);
      this.nextVoice = { key, ctrl, voice, timer };
      this.trace("voix suivante en préparation");
      return null;
    }
    const ctrl = new AbortController();
    this.preparations.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), 3500);
    try {
      const res = await fetch("/api/speak/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-murmure-code": this.code },
        body: JSON.stringify({ texte: text, language: this.language }),
        signal: ctrl.signal,
      });
      if (!res.ok || ctrl.signal.aborted) return null;
      const j = (await res.json()) as { id?: string | null };
      return ctrl.signal.aborted ? null : j.id ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      this.preparations.delete(ctrl);
    }
  }

  private playAudio(src: string, ctrl: AbortController, deadline: number, onStart?: () => void, stream = false): Promise<void> {
    const audio = this.audio;
    if (!audio) return Promise.reject(new Error("son non débloqué"));
    if (ctrl.signal.aborted) return Promise.reject(ctrl.signal.reason);
    return new Promise((resolve, reject) => {
      let started = false;
      let settled = false;
      const requestedAt = Date.now();
      let waitingAt: number | null = null;
      const cleanup = () => {
        clearTimeout(guard);
        clearTimeout(end);
        ctrl.signal.removeEventListener("abort", cancel);
        if (audio.onplaying === playing) audio.onplaying = null;
        if (audio.onended === ended) audio.onended = null;
        if (audio.onerror === failed) audio.onerror = null;
        if (audio.onwaiting === waiting) audio.onwaiting = null;
        if (audio.onstalled === stalled) audio.onstalled = null;
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          if (this.operation === ctrl) this.resetAudio();
          reject(error);
        } else resolve();
      };
      const cancel = () => finish(ctrl.signal.reason);
      const guard = setTimeout(() => ctrl.abort(new Error("voix trop lente à démarrer")), Math.max(0, deadline - Date.now()));
      const end = setTimeout(() => finish(new Error("lecture audio trop longue")), 20000);
      const playing = () => {
        if (waitingAt !== null) {
          this.trace("audio repris", `${Date.now() - waitingAt} ms de coupure`);
          waitingAt = null;
        }
        if (started || settled) return;
        if (ctrl.signal.aborted || Date.now() >= deadline) {
          finish(ctrl.signal.reason ?? new Error("voix trop lente à démarrer"));
          return;
        }
        started = true;
        clearTimeout(guard);
        this.trace("audio démarré", `${Date.now() - requestedAt} ms après demande de lecture`);
        onStart?.();
      };
      const waiting = () => {
        if (!started || settled || waitingAt !== null) return;
        waitingAt = Date.now();
        this.trace("audio en attente", "lecture interrompue après le premier son");
      };
      const stalled = () => { if (!settled) this.trace("chargement audio bloqué", started ? "pendant la lecture" : "avant le premier son"); };
      const ended = () => {
        if (settled || ctrl.signal.aborted) return;
        if (!started) return finish(new Error("lecture audio sans son"));
        this.trace(stream ? "voix jouée (flux)" : "voix jouée", `${Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : "?"} s`);
        finish();
      };
      const failed = () => finish(new Error(`lecture audio impossible, code ${audio.error?.code}`));
      ctrl.signal.addEventListener("abort", cancel, { once: true });
      audio.onplaying = playing;
      audio.onended = ended;
      audio.onerror = failed;
      audio.onwaiting = waiting;
      audio.onstalled = stalled;
      audio.src = src;
      audio.defaultPlaybackRate = RATE;
      audio.playbackRate = RATE;
      audio.play().catch(finish);
    });
  }

  async sayStream(text: string, onStart?: () => void, maxWait = 3500, preparedId?: string | null, expiresAt = Infinity): Promise<Spoken> {
    const next = this.nextVoice?.key === `${this.language}:${text}` ? this.nextVoice : null;
    if (next) {
      this.nextVoice = null;
      clearTimeout(next.timer);
    } else this.discardNextVoice();
    const op = this.begin();
    const deadline = Math.min(expiresAt, Date.now() + maxWait);
    const cancelNext = () => next?.ctrl.abort();
    op.ctrl.signal.addEventListener("abort", cancelNext, { once: true });
    try {
      if (Date.now() >= deadline) return { via: "openai", error: "voix trop lente à démarrer" };
      if (next) {
        const blob = await this.beforeDeadline(next.voice, op.ctrl, deadline);
        if (blob) {
          this.trace("voix préparée sur le téléphone");
          return await this.sayFile(text, op.ctrl, deadline, onStart, Promise.resolve(blob));
        }
      }
      if (this.audio && this.streamFailures < 2) {
        const id = preparedId ? `&id=${encodeURIComponent(preparedId)}` : "";
        const src = `/api/speak?k=${encodeURIComponent(this.code)}&t=${encodeURIComponent(text)}&language=${this.language}${id}`;
        try {
          await this.playAudio(src, op.ctrl, deadline, onStart, true);
          this.streamFailures = 0;
          return { via: "openai" };
        } catch (e) {
          if (op.epoch !== this.epoch || op.ctrl.signal.aborted || Date.now() >= deadline) throw e;
          this.streamFailures += 1;
          if (this.streamFailures === 2) this.trace("flux abandonné pour la séance", "retour au fichier entier");
          this.trace("flux en échec, fichier entier", e instanceof Error ? e.message : String(e));
        }
      }
      return await this.sayFile(text, op.ctrl, deadline, onStart);
    } catch (e) {
      return { via: "openai", error: op.epoch !== this.epoch ? "annulé" : e instanceof Error ? e.message : String(e) };
    } finally {
      op.ctrl.signal.removeEventListener("abort", cancelNext);
      next?.ctrl.abort();
      if (op.epoch === this.epoch) {
        this.operation = null;
        this.busy = false;
      }
    }
  }

  /** Coupe et libère immédiatement la lecture, sans attendre un événement du navigateur. */
  cut() {
    this.interrupt();
  }

  async say(text: string, voice?: Promise<Blob>, onStart?: () => void, expiresAt = Date.now() + 3500): Promise<Spoken> {
    const op = this.begin();
    try {
      if (Date.now() >= expiresAt) return { via: "openai", error: "voix trop lente à démarrer" };
      return await this.sayFile(text, op.ctrl, expiresAt, onStart, voice);
    } catch (e) {
      return { via: "openai", error: op.epoch !== this.epoch ? "annulé" : e instanceof Error ? e.message : String(e) };
    } finally {
      if (op.epoch === this.epoch) {
        this.operation = null;
        this.busy = false;
      }
    }
  }

  private async sayFile(text: string, ctrl: AbortController, deadline: number, onStart?: () => void, voice?: Promise<Blob>): Promise<Spoken> {
    try {
      const blob = await this.beforeDeadline(voice ?? this.fetchVoice(text, ctrl.signal), ctrl, deadline);
      if (ctrl.signal.aborted) throw ctrl.signal.reason;
      this.url = URL.createObjectURL(blob);
      await this.playAudio(this.url, ctrl, deadline, onStart);
      return { via: "openai" };
    } catch (e) {
      if (ctrl.signal.aborted || Date.now() >= deadline) throw e;
      const err = e instanceof Error ? e.message : String(e);
      this.trace("voix OpenAI en échec", err);
      await this.fallback(text, ctrl, deadline, onStart);
      return { via: "telephone", error: err };
    }
  }

  /** Le secours respecte lui aussi l'arrêt et l'échéance du premier son. */
  private fallback(text: string, ctrl: AbortController, deadline: number, onStart?: () => void): Promise<void> {
    if (ctrl.signal.aborted) return Promise.reject(ctrl.signal.reason);
    if (Date.now() >= deadline) return Promise.reject(new Error("voix trop lente à démarrer"));
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.language === "en" ? "en-US" : "fr-FR";
      u.rate = 1.15;
      const preferred = this.language === "en" ? ["en-US", "en"] : ["fr-FR", "fr"];
      const voice = window.speechSynthesis.getVoices().find((v) => preferred.some((lang) => v.lang.toLowerCase().startsWith(lang.toLowerCase())));
      if (voice) u.voice = voice;
      let started = false;
      let settled = false;
      const done = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        clearTimeout(end);
        ctrl.signal.removeEventListener("abort", cancel);
        u.onstart = u.onend = u.onerror = null;
        if (error) {
          window.speechSynthesis.cancel();
          reject(error);
        } else resolve();
      };
      const cancel = () => done(ctrl.signal.reason);
      const guard = setTimeout(() => done(new Error("voix trop lente à démarrer")), Math.max(0, deadline - Date.now()));
      const end = setTimeout(() => done(new Error("lecture audio trop longue")), 20000);
      ctrl.signal.addEventListener("abort", cancel, { once: true });
      u.onstart = () => {
        if (started || settled) return;
        if (ctrl.signal.aborted || Date.now() >= deadline) return done(ctrl.signal.reason ?? new Error("voix trop lente à démarrer"));
        started = true;
        clearTimeout(guard);
        onStart?.();
      };
      u.onend = () => done();
      u.onerror = () => done(new Error("voix du téléphone indisponible"));
      window.speechSynthesis.speak(u);
    });
  }
}
