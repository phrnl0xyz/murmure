"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { captureGrid, captureJpeg, gridDiff, type Grid } from "@/lib/client/vision";
import { Speaker } from "@/lib/client/speaker";
import { overlap } from "@/lib/client/text";
import type { Description, Verdict, Verification } from "@/lib/types";
import { normalizeLanguage, spoken as localizedSpeech, t, type Language } from "@/lib/language";

type Kind = "dit" | "tu" | "cadrage" | "info" | "erreur";
type Entry = { id: number; t: number; kind: Kind; text: string; detail?: string };
type Phase = "arret" | "cadrage" | "narration" | "pause";
type Mode = "ecran" | "monde"; // devant un écran, ou dans la rue
type Pending = { text: string; priority: number; grid: Grid; triggeredAt: number; queuedAt: number; detail: string; nature: string; mode: Mode; voiceId: Promise<string | null> };

// Tous les réglages au même endroit, pour les ajuster sur une vraie télé.
const C = {
  tick: 400, // une image toutes les 0,4 s
  parallel: 2, // analyses simultanées
  flushTick: 150,
  changeThreshold: 0.15, // part des 144 cases qui doit changer pour appeler le juge
  forceNarration: 8000, // contrôle forcé même sans changement
  forceFraming: 2500,
  importantMin: 0.7,
  unusableMin: 0.6,
  minGap: 1000, // écart minimum entre deux phrases, sauf urgence
  urgent: 1.5, // priorité à partir de laquelle on parle tout de suite
  ttl: 4000, // une phrase en attente plus de 4 s est jetée
  staleDiff: 0.5, // description de scène : si l'image a changé à plus de 50 % avant de parler, on jette
  repeatWindow: 30000,
  repeatWindowMonde: 60000, // dans la rue, on repasse souvent devant la même enseigne
  rejectedWindowMonde: 3000, // une nouvelle vue plus nette peut faire vérifier de nouveau un premier refus
  mondeEvery: 1000,
  mondeRefresh: 2000, // même un petit changement reste surveillé sans attendre huit secondes
  speculative: 0.15, // l'action va vite : le conteur part dès qu'une image change vraiment
  noScreenSwitch: 5, // pendant le cadrage, 5 analyses sans écran : passage automatique au mode rue
  repeatOverlap: 0.6,
  certMin: 0.4,
  verifyMin: 0.7, // en dessous, la phrase n'est pas dite
  framingCueEvery: 5000,
  framingLost: 5000,
  unusableEvery: 60000,
  frameWatchdog: 5000,
  voiceWait: 3000, // si la voix n'a pas démarré après 3 s, on se tait plutôt que parler en retard
  frozenTicks: 5, // 5 images strictement identiques : la caméra est figée
  sceneAfter: 25000, // devant un écran, une description de scène après 25 s de silence
  sceneAfterMonde: 12000, // dans la rue, après 12 s de silence on décrit les alentours
  importantMinMonde: 0.5,
  commentaryCertMin: 0.5,
  commentaryStagger: 1000, // une nouvelle rédaction au plus toutes les secondes (coût)
  commentaryMaxBackoff: 4000, // attente maximale entre deux rédactions quand rien ne change
  commentaryStill: 0.08, // en dessous de 8 % de l'image changée, on considère l'image immobile
  commentaryTextChange: 4 / (64 * 36), // quatre petites cases suffisent pour revérifier un texte
  commentaryTextEvery: 2000,
  commentaryFresh: 2500, // une phrase en réserve de moins de 2,5 s suffit : inutile d'en rédiger d'autres
  screenCheckEvery: 4000, // contrôle du cadrage en parallèle du commentaire
  screenCheckConfirm: 500, // confirmer rapidement un écran perdu avant d'interrompre
  verifyMinMonde: 0.5, // seuil des descriptions d'alentours dans la rue
};

const CUES: Record<string, string> = {
  trop_a_gauche: "Tourne le téléphone un peu vers la gauche.",
  trop_a_droite: "Tourne le téléphone un peu vers la droite.",
  trop_haut: "Incline le téléphone un peu vers le haut.",
  trop_bas: "Incline le téléphone un peu vers le bas.",
  trop_loin: "Rapproche un peu le téléphone de l'écran.",
  pas_de_tele: "Je ne vois pas d'écran. Tourne lentement le téléphone.",
};

function framingCue(language: Language, key: string): string {
  if (language === "fr") return CUES[key] ?? CUES.pas_de_tele;
  const cues: Record<string, string> = {
    trop_a_gauche: "Turn the phone slightly to the left.",
    trop_a_droite: "Turn the phone slightly to the right.",
    trop_haut: "Tilt the phone slightly upward.",
    trop_bas: "Tilt the phone slightly downward.",
    trop_loin: "Move the phone a little closer to the screen.",
    pas_de_tele: "I can’t see a screen. Slowly turn the phone.",
  };
  return cues[key] ?? cues.pas_de_tele;
}

function sourceLabel(source: string, language: Language): string {
  if (source === "decisions") return "Decisions API";
  if (source === "sol") return language === "en" ? "GPT-6.1 Sol (fallback)" : "GPT-6.1 Sol (plan B)";
  if (source === "simulation") return "simulation";
  return source;
}
const PHASE_LABEL: Record<Phase, Record<Language, string>> = {
  arret: { fr: "Arrêté", en: "Stopped" }, cadrage: { fr: "Je cherche l’écran", en: "Finding the screen" },
  narration: { fr: "Je regarde", en: "Watching" }, pause: { fr: "En pause", en: "Paused" },
};
const KIND_LABEL: Record<Kind, Record<Language, string>> = {
  dit: { fr: "Chuchoté", en: "Spoken" }, tu: { fr: "Pas dit", en: "Not spoken" }, cadrage: { fr: "Cadrage", en: "Framing" },
  info: { fr: "Info", en: "Info" }, erreur: { fr: "Problème", en: "Issue" },
};
const DEMO_VIDEO = "/test/ecrans.mp4";


type Problem = { title: string; body: string; kind?: "access" };

// Explique en clair pourquoi la caméra ne s'ouvre pas, et quoi faire.
function cameraProblem(e: unknown, language: Language = "fr"): Problem {
  if (language === "en") {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return {
      title: "Your browser is blocking the camera",
      body: "Safari only opens the camera on a secure https address. This page is using the Mac’s local http address. Open Murmure’s https link instead.",
    };
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return {
      title: "Camera access was denied",
      body: "In Safari, tap ‘aA’ in the address bar, then Website Settings, then Camera: Allow. Reload the page afterward.",
    };
    if (name === "NotFoundError" || name === "OverconstrainedError") return { title: "No camera found", body: "This device has no usable camera. You can try the demo without a camera." };
    if (name === "NotReadableError" || name === "AbortError") return {
      title: "The camera is still in use",
      body: "Another tab or app may be using it. Close other Murmure tabs, then press Start again.",
    };
    return { title: "The camera did not open", body: e instanceof Error ? e.message : String(e) };
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return {
      title: "Le navigateur bloque la caméra",
      body: "Safari n'ouvre la caméra que sur une adresse sécurisée, qui commence par https. Cette page est ouverte en http, depuis l'adresse locale du Mac. Ouvre plutôt le lien https de Murmure.",
    };
  }
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      title: "L'accès à la caméra a été refusé",
      body: "Dans Safari, touche « aA » dans la barre d'adresse, puis « Réglages du site web », puis Caméra : Autoriser. Recharge ensuite la page.",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return { title: "Aucune caméra trouvée", body: "Cet appareil n'a pas de caméra utilisable. Tu peux essayer la démo sans caméra." };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      title: "La caméra est encore prise",
      body: "Un autre onglet ou une autre appli s'en sert peut-être. Ferme les autres onglets de Murmure, puis appuie à nouveau sur Commencer.",
    };
  }
  return { title: "La caméra ne s'est pas ouverte", body: e instanceof Error ? e.message : String(e) };
}

function accessProblem(language: Language): Problem {
  return {
    title: t(language, "missingCodeTitle"),
    body: t(language, "missingCodeBody"),
    kind: "access",
  };
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

async function post<T>(url: string, body: unknown, code: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-murmure-code": code },
    body: JSON.stringify(body),
    signal,
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export default function Murmure() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const speaker = useRef<Speaker>(new Speaker());

  const [phase, setPhase] = useState<Phase>("arret");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [detail] = useState<"sobre" | "detaille">("sobre"); // le mode détaillé reste dans le code, sans bouton
  const [judgeSource, setJudgeSource] = useState("");
  const [voiceNote, setVoiceNote] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [simulation, setSimulation] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [now, setNow] = useState(0);
  const [cue, setCue] = useState("");
  const [mode, setMode] = useState<Mode>("ecran");
  const [reaction, setReaction] = useState<number | null>(null); // secondes entre l'image et le premier son
  const [startedAt, setStartedAt] = useState(0);
  const [demoVideo, setDemoVideo] = useState<string | null>(null);
  const [cams, setCams] = useState<{ id: string; label: string }[]>([]);
  const [camId, setCamId] = useState(""); // "" : automatique, caméra arrière
  // Vitesse du conteur : « eco » = palier fast (prix x2), « rapide » = palier ultrafast (prix x6).
  const [vitesse, setVitesse] = useState<"eco" | "rapide">("eco");
  const [language, setLanguage] = useState<Language>("fr");
  // Vérification au chargement : code d'accès et clé OpenAI. Tant que ce n'est pas « ok », on ne peut pas démarrer.
  const [access, setAccess] = useState<"checking" | "ok" | "missing" | "wrong" | "nokey" | "down">("checking");
  const vitesseRef = useRef<"eco" | "rapide">("eco");
  const languageRef = useRef<Language>("fr");

  const chooseLanguage = useCallback((value: string) => {
    const next = normalizeLanguage(value);
    languageRef.current = next;
    speaker.current.language = next;
    setLanguage(next);
    document.documentElement.lang = next;
    try { localStorage.setItem("murmure-language", next); } catch {}
  }, []);

  const phaseRef = useRef<Phase>("arret");
  const detailRef = useRef(detail);
  const codeRef = useRef("");
  const remoteEnabled = useRef(false);
  const demoRef = useRef<string | null>(null);
  const urlDemoRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const timers = useRef<number[]>([]);
  const idRef = useRef(0);
  const lastJudgedGrid = useRef<Grid | null>(null);
  const lastJudgeAt = useRef(0);
  const inFlight = useRef(0); // nombre d'analyses en cours : deux à la fois, pour ne pas faire attendre un nouvel écran
  const newestQueued = useRef(0);
  const spoken = useRef<{ text: string; t: number }[]>([]);
  const rejected = useRef<{ text: string; t: number }[]>([]); // phrases refusées par le vérificateur : ne pas les refaire
  const pending = useRef<Pending | null>(null);
  const lastSpeechEnd = useRef(0);
  const framingGood = useRef(0);
  const badFramingSince = useRef<number | null>(null);
  const lastCueAt = useRef(0);
  const lastUnusableAt = useRef(0);
  const lastFrameAt = useRef(0);
  const warnedNoFrame = useRef(false);
  const hiddenAt = useRef<number | null>(null);
  const warnedWake = useRef(false);
  const starting = useRef(false);
  const modeRef = useRef<Mode>("ecran");
  const noScreen = useRef(0); // images d'affilée sans aucun écran visible
  // Numéro de séance : à l'arrêt il change, et tout ce qui était en route pour l'ancienne séance est jeté.
  const session = useRef(0);
  const restarting = useRef(false);
  const flushing = useRef<number | null>(null);
  const speechId = useRef(0);
  const speakingNature = useRef("");
  const speakingT0 = useRef(0);
  const commentaryOn = useRef<number | null>(null); // séance propriétaire de la boucle
  const requests = useRef(new Set<AbortController>());
  const cameraEpoch = useRef(0);
  const resumePhase = useRef<"cadrage" | "narration">("narration");
  const hiddenResume = useRef<"cadrage" | "narration" | null>(null);
  const screenCheck = useRef<{ sid: number | null; next: number; misses: number }>({ sid: null, next: 0, misses: 0 });
  const frozen = useRef(0);
  const prevGrid = useRef<Grid | null>(null);
  const camIdRef = useRef("");
  const tickRef = useRef<() => void>(() => {});
  // Commandes des écouteurs (AirPods) : la fonction à jour est rangée ici, le gestionnaire est posé une fois.
  const mediaRef = useRef<{ toggle: () => void; stop: () => void }>({ toggle: () => {}, stop: () => {} });
  const pauseBtnRef = useRef<HTMLButtonElement>(null);
  const firstStartRef = useRef<HTMLButtonElement>(null);
  const flushRef = useRef<() => void>(() => {});

  // Mode réglage : chaque événement part aussi vers le Mac, pour comprendre un essai à distance.
  const remote = useCallback((event: string, detail?: string) => {
    if (!remoteEnabled.current || !codeRef.current) return;
    void fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-murmure-code": codeRef.current },
      body: JSON.stringify({ event, detail }),
    }).catch(() => {});
  }, []);

  const log = useCallback((kind: Kind, text: string, detailText?: string) => {
    remote(`${kind} : ${text}`, detailText);
    idRef.current += 1;
    const e: Entry = { id: idRef.current, t: Date.now(), kind, text, detail: detailText };
    setEntries((prev) => [e, ...prev].slice(0, 80));
  }, [remote]);

  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  function invalidateWork() {
    session.current += 1;
    speechId.current += 1;
    for (const ctrl of requests.current) ctrl.abort();
    requests.current.clear();
    speaker.current.stop();
    pending.current = null;
    inFlight.current = 0;
    flushing.current = null;
    newestQueued.current = 0;
    screenCheck.current = { sid: null, next: Date.now() + C.screenCheckEvery, misses: 0 };
    setSpeaking(false);
    return session.current;
  }

  async function request<T>(url: string, body: unknown, deadline: number, signal?: AbortSignal): Promise<T> {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(signal?.reason);
    const timer = window.setTimeout(() => ctrl.abort(new DOMException("Analyse trop lente", "TimeoutError")), Math.max(0, deadline - Date.now()));
    requests.current.add(ctrl);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      if (Date.now() >= deadline) throw new DOMException("Analyse trop lente", "TimeoutError");
      return await post<T>(url, body, codeRef.current, ctrl.signal);
    } catch (e) {
      throw ctrl.signal.aborted ? ctrl.signal.reason : e;
    } finally {
      window.clearTimeout(timer);
      requests.current.delete(ctrl);
      signal?.removeEventListener("abort", abort);
    }
  }

  // Paramètres d'URL : ?video=/demo.mp4 pour la démo sur ordinateur, ?code=... pour l'accès.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("video");
    const urlCode = params.get("code");
    let code = urlCode ?? "";
    try {
      if (urlCode) localStorage.setItem("murmure-code", urlCode);
      else code = localStorage.getItem("murmure-code") ?? "";
    } catch {}
    try {
      const saved = localStorage.getItem("murmure-camera") ?? "";
      const savedLanguage = normalizeLanguage(localStorage.getItem("murmure-language"));
      languageRef.current = savedLanguage;
      speaker.current.language = savedLanguage;
      document.documentElement.lang = savedLanguage;
      camIdRef.current = saved;
      const v = localStorage.getItem("murmure-vitesse") === "rapide" ? "rapide" : "eco";
      vitesseRef.current = v;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- lecture unique des réglages mémorisés et de l'URL au montage
      setCamId(saved);
      setVitesse(v);
      setLanguage(savedLanguage);
    } catch {}
    void refreshCams();
    navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshCams());
    codeRef.current = code;
    speaker.current.code = code;
    speaker.current.trace = (event, detail) => remote(`son : ${event}`, detail);
    demoRef.current = v;
    urlDemoRef.current = v;
    setDemoVideo(v);
    void fetch("/api/access", { method: "POST", headers: { "x-murmure-code": code } })
      .then((r) => r.json() as Promise<{ code: "ok" | "missing" | "wrong"; openai: boolean; debug?: boolean; voicePreparation?: boolean }>)
      .then((a) => {
        remoteEnabled.current = a.code === "ok" && a.debug === true;
        speaker.current.preparationEnabled = a.code === "ok" && a.voicePreparation === true;
        setAccess(a.code !== "ok" ? a.code : a.openai ? "ok" : "nokey");
      })
      .catch(() => setAccess("down"));
  }, [remote]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  const recentTexts = () => spoken.current.slice(-3).map((s) => s.text);

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) wakeRef.current = await navigator.wakeLock.request("screen");
    } catch {
      if (!warnedWake.current) log("info", "Impossible d'empêcher la mise en veille. Garde le téléphone branché et l'écran allumé.");
      warnedWake.current = true;
    }
  }

  function releaseCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const video = videoRef.current;
    const src = video?.srcObject;
    if (src instanceof MediaStream) src.getTracks().forEach((t) => t.stop());
    if (video) video.srcObject = null;
  }

  async function startCamera(wanted?: string) {
    const cameraId = ++cameraEpoch.current;
    const video = videoRef.current;
    if (!video) throw new Error("vidéo absente");
    releaseCamera();
    let deviceId = wanted ?? (camIdRef.current || undefined);
    if (deviceId && cams.length && !cams.some((c) => c.id === deviceId)) deviceId = undefined; // caméra débranchée
    const constraints: MediaStreamConstraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false, // jamais de micro : voir le cadrage, section 6
    };
    let stream: MediaStream;
    // Sur iPhone, la caméra met parfois quelques secondes à se libérer : on réessaie jusqu'à 4 fois.
    for (let attempt = 1; ; attempt++) {
      if (cameraId !== cameraEpoch.current) throw new DOMException("Caméra annulée", "AbortError");
      try {
        stream = await navigator.mediaDevices.getUserMedia(attempt <= 2 ? constraints : { video: true, audio: false });
        break;
      } catch (e) {
        const busy = e instanceof DOMException && (e.name === "NotReadableError" || e.name === "AbortError");
        if (!busy || attempt >= 4) throw e;
        remote("caméra occupée, nouvel essai", String(attempt));
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (cameraId !== cameraEpoch.current) {
      stream.getTracks().forEach((t) => t.stop());
      throw new DOMException("Caméra annulée", "AbortError");
    }
    // Si iOS coupe la caméra en cours de route, on la relance.
    stream.getVideoTracks().forEach((t) => {
      t.onended = () => {
        if (phaseRef.current !== "arret" && document.visibilityState === "visible" && streamRef.current === stream) void restartCamera("caméra coupée");
      };
    });
    streamRef.current = stream;
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    if (cameraId !== cameraEpoch.current) {
      stream.getTracks().forEach((t) => t.stop());
      throw new DOMException("Caméra annulée", "AbortError");
    }
    void refreshCams(); // les noms des caméras ne sont lisibles qu'après l'autorisation
  }

  // Liste des caméras : sur ordinateur, webcam, iPhone en Continuité, caméra USB ; sur iPhone, les objectifs.
  async function refreshCams() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const list = devices
        .filter((d) => d.kind === "videoinput" && d.deviceId)
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Caméra ${i + 1}` }));
      setCams(list);
    } catch {}
  }

  // Le navigateur ne donne la liste des caméras qu'après une autorisation : on ouvre la caméra un instant.
  async function askCams() {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      st.getTracks().forEach((t) => t.stop());
      await refreshCams();
    } catch (e) {
      setProblem(cameraProblem(e, languageRef.current));
    }
  }

  function chooseVitesse(v: "eco" | "rapide") {
    vitesseRef.current = v;
    setVitesse(v);
    try {
      localStorage.setItem("murmure-vitesse", v);
    } catch {}
  }

  function chooseCam(id: string) {
    camIdRef.current = id;
    setCamId(id);
    try {
      localStorage.setItem("murmure-camera", id);
    } catch {}
  }

  async function nextCam() {
    if (cams.length < 2) return;
    const i = cams.findIndex((c) => c.id === camIdRef.current);
    const next = cams[(i + 1) % cams.length];
    const sid = invalidateWork();
    chooseCam(next.id);
    try {
      await startCamera(next.id);
      if (sid !== session.current) return;
      lastJudgedGrid.current = null;
      frozen.current = 0;
      log("info", `Caméra : ${next.label}`);
    } catch (e) {
      if (sid !== session.current || (e instanceof DOMException && e.name === "AbortError")) return;
      log("erreur", "Impossible de changer de caméra.", e instanceof Error ? e.message : String(e));
    }
  }

  async function restartCamera(reason: string) {
    if (restarting.current || demoRef.current) return;
    restarting.current = true;
    const sid = invalidateWork();
    log("erreur", "La caméra s'est arrêtée, je la relance.", reason);
    try {
      await startCamera();
      if (sid !== session.current) return;
      frozen.current = 0;
    } catch (e) {
      if (sid !== session.current || (e instanceof DOMException && e.name === "AbortError")) return;
      log("erreur", "Impossible de relancer la caméra.", e instanceof Error ? e.message : String(e));
    } finally {
      restarting.current = false;
    }
  }

  async function startSource() {
    const video = videoRef.current;
    if (!video) throw new Error("vidéo absente");
    const demo = demoRef.current;
    if (demo) {
      video.srcObject = null;
      video.src = demo;
      video.loop = true;
      video.muted = false;
      await video.play();
      return;
    }
    await startCamera();
  }

  function clearTimers() {
    timers.current.forEach((t) => window.clearInterval(t));
    timers.current = [];
  }

  async function start(m: Mode = "ecran") {
    if (starting.current || phaseRef.current !== "arret") return; // un double appui ouvrirait deux caméras
    starting.current = true;
    const startSession = invalidateWork();
    const unlocking = speaker.current.unlock(); // doit partir dans le geste de l'utilisateur, avant tout await
    modeRef.current = m;
    setMode(m);
    setProblem(null);
    setEntries([]);
    setReaction(null);
    setVoiceNote("");
    setJudgeSource("");
    try {
      await startSource();
    } catch (e) {
      starting.current = false;
      if (startSession !== session.current) return;
      releaseCamera();
      const p = demoRef.current
        ? {
            title: languageRef.current === "en" ? "The demo video won’t play" : "La vidéo de démo ne se lance pas",
            body: e instanceof Error ? e.message : String(e),
          }
        : cameraProblem(e, languageRef.current);
      setProblem(p);
      void speaker.current.say(`${p.title}.`);
      return;
    }
    starting.current = false;
    const sound = await unlocking;
    if (startSession !== session.current) return;
    setupMediaSession(m);
    log(sound.ok ? "info" : "erreur", sound.ok ? "Son débloqué." : "Son bloqué par le navigateur.", sound.detail);
    await requestWakeLock();
    if (startSession !== session.current) return;
    setCue("");
    lastJudgedGrid.current = null;
    lastJudgeAt.current = 0;
    spoken.current = [];
    rejected.current = [];
    newestQueued.current = 0;
    inFlight.current = 0;
    pending.current = null;
    framingGood.current = 0;
    noScreen.current = 0;
    badFramingSince.current = null;
    lastFrameAt.current = Date.now();
    warnedNoFrame.current = false;
    clearTimers();
    setStartedAt(Date.now());
    setNow(Date.now());
    timers.current.push(window.setInterval(() => setNow(Date.now()), 1000));
    timers.current.push(window.setInterval(() => tickRef.current(), C.tick));
    timers.current.push(window.setInterval(() => flushRef.current(), C.flushTick));
    lastSpeechEnd.current = 0;
    // Bonjour avec la vraie voix, par le même chemin que les phrases : si tu l'entends, le son marche.
    const hello = demoRef.current
      ? localizedSpeech(languageRef.current, "helloDemo")
      : m === "monde"
        ? localizedSpeech(languageRef.current, "helloAround")
        : localizedSpeech(languageRef.current, "hello");
    if (m === "monde" && !demoRef.current) {
      setPhaseBoth("narration");
      log("info", "Mode autour de moi : enseignes, panneaux, transports.");
    } else if (demoRef.current) {
      setPhaseBoth("narration");
      log("info", "Mode démonstration sur une vidéo, sans cadrage.");
    } else {
      setPhaseBoth("cadrage");
      log("info", "Murmure démarre. Recherche de la télé.");
    }
    const helloSession = session.current;
    void speaker.current.say(hello).then((r) => {
      if (helloSession !== session.current) return;
      setVoiceNote(r.via === "openai" ? (languageRef.current === "en" ? "OpenAI voice" : "voix OpenAI") : (languageRef.current === "en" ? "device voice" : "voix du téléphone"));
      log(r.error ? "erreur" : "info", r.error ? "Le bonjour n'a pas pu passer par la voix OpenAI." : "Bonjour dit avec la voix OpenAI.", r.error);
    });
  }

  // Les écouteurs pilotent Murmure : un appui sur la tige des AirPods met en pause ou relance,
  // et retirer un écouteur met en pause, comme pour la musique.
  function setupMediaSession(m: Mode) {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms) return;
    try {
      ms.metadata = new MediaMetadata({ title: "Murmure", artist: m === "monde" ? "Autour de moi" : "Devant un écran" });
      const toggle = () => {
        remote("écouteurs : pause ou reprise");
        mediaRef.current.toggle();
      };
      ms.setActionHandler("pause", toggle);
      ms.setActionHandler("play", toggle);
      ms.setActionHandler("stop", () => mediaRef.current.stop());
      ms.playbackState = "playing";
    } catch {}
  }

  function clearMediaSession() {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms) return;
    try {
      for (const a of ["pause", "play", "stop"] as MediaSessionAction[]) ms.setActionHandler(a, null);
      ms.playbackState = "none";
    } catch {}
  }

  function startDemo() {
    demoRef.current = DEMO_VIDEO;
    setDemoVideo(DEMO_VIDEO);
    void start();
  }

  function stop() {
    invalidateWork();
    cameraEpoch.current += 1;
    hiddenResume.current = null;
    clearMediaSession();
    clearTimers();
    videoRef.current?.pause();
    releaseCamera();
    void wakeRef.current?.release().catch(() => {});
    wakeRef.current = null;
    pending.current = null;
    setPhaseBoth("arret");
    demoRef.current = urlDemoRef.current;
    setDemoVideo(urlDemoRef.current);
    log("info", "Murmure arrêté.");
  }

  function togglePause() {
    if (phaseRef.current === "pause") {
      invalidateWork();
      hiddenResume.current = null;
      setPhaseBoth(resumePhase.current);
      lastJudgedGrid.current = null;
      if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
      void speaker.current.say(localizedSpeech(languageRef.current, "resume"));
    } else if (phaseRef.current === "narration" || phaseRef.current === "cadrage") {
      resumePhase.current = phaseRef.current;
      invalidateWork();
      setPhaseBoth("pause");
      if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused";
      void speaker.current.say(localizedSpeech(languageRef.current, "pause"));
    }
  }





  // Analyse d'une image : juge, puis conteur, puis vérificateur.
  async function analyse(video: HTMLVideoElement, grid: Grid, ch: number, t0: number) {
    const sid = session.current;
    const gone = () => sid !== session.current || phaseRef.current === "arret";
    const md = modeRef.current;
    const deadline = t0 + C.ttl * (md === "monde" ? 1 : 2);
    const recent = recentTexts();
    const small = captureJpeg(video, 768, 0.72);
    const big = captureJpeg(video, 768, 0.8);
    if (!small || !big) return;
    const ph = phaseRef.current;
    const sp = speaker.current;
    // Seulement utile à la simulation sans clé, pour suivre le script de la vidéo de test.
    const demoTime = demoRef.current ? video.currentTime : undefined;
    const rejectedSpan = md === "monde" ? C.rejectedWindowMonde : C.repeatWindow;
    const refused = rejected.current.filter((r) => t0 - r.t < rejectedSpan).map((r) => r.text);
    const describeBody = { image: big, recent: [...recent, ...refused], detail: detailRef.current, demoTime, mode: md, vitesse: vitesseRef.current, language: languageRef.current };

    let spec: { ctrl: AbortController; p: Promise<Description> } | null = null;
    // Le conteur part à l'avance seulement sur un vrai changement d'image ; sinon il attend l'avis du juge (0,3 s).
    if (ph === "narration" && (ch >= C.speculative || md === "monde")) {
      const ctrl = new AbortController();
      const p = request<Description>("/api/describe", describeBody, deadline, ctrl.signal);
      p.catch(() => {});
      spec = { ctrl, p };
    }
    const abortSpec = () => spec?.ctrl.abort();

    const v = await request<Verdict>("/api/judge", { image: small, recent, mode: md, language: languageRef.current }, deadline);
    if (gone()) return abortSpec();
    setJudgeSource(sourceLabel(v.source, languageRef.current));
    if (v.source === "simulation") setSimulation(true);
    const scores = `importance ${pct(v.important)}, nature ${v.nature}, priorité ${v.priorite.toFixed(1)}, cadrage ${v.cadrage}, télé ${pct(v.teleVisible)}, juge ${v.ms} ms`;

    if (!demoRef.current && md === "ecran") {
      const framed = v.teleVisible >= 0.5 && (v.cadrage === "bon" || v.cadrage === "trop_loin");
      if (!framed) {
        abortSpec();
        // Aucun écran du tout pendant ~2 s : la personne est sans doute dehors. On passe seul en mode « Autour de moi ».
        noScreen.current = v.teleVisible < 0.3 ? noScreen.current + 1 : 0;
        if (noScreen.current >= C.noScreenSwitch && !sp.busy) {
          invalidateWork();
          noScreen.current = 0;
          modeRef.current = "monde";
          setMode("monde");
          setCue("");
          setPhaseBoth("narration");
          lastJudgedGrid.current = null;
          log("info", "Pas d'écran en vue : passage au mode autour de moi.");
        void sp.say(localizedSpeech(languageRef.current, "noScreen"));
          return;
        }
        framingGood.current = 0;
        badFramingSince.current ??= t0;
        const lostLong = t0 - badFramingSince.current >= C.framingLost;
        if (ph === "narration" && lostLong) setPhaseBoth("cadrage");
        if ((ph === "cadrage" || lostLong) && t0 - lastCueAt.current >= C.framingCueEvery && !sp.busy) {
          lastCueAt.current = t0;
          const key = v.teleVisible < 0.5 && v.cadrage === "bon" ? "pas_de_tele" : v.cadrage;
          if (key === "pas_de_tele" || v.teleVisible < 0.3) return; // pas d'écran : le passage au mode rue s'en charge
          const cue = framingCue(languageRef.current, key);
          log("cadrage", cue, scores);
          setCue(cue);
          void sp.say(cue);
        }
        return;
      }
      badFramingSince.current = null;
      noScreen.current = 0;
      if (ph === "cadrage") {
        framingGood.current += 1;
        if (framingGood.current >= 1) {
          setPhaseBoth("narration");
          lastJudgedGrid.current = null; // relance tout de suite une analyse du contenu
          log("cadrage", "Écran trouvé.", scores);
        }
        return;
      }
    }

    if (v.inutilisable >= C.unusableMin) {
      abortSpec();
      if (t0 - lastUnusableAt.current >= C.unusableEvery) {
        lastUnusableAt.current = t0;
        const m =
          md === "monde"
            ? localizedSpeech(languageRef.current, "blurAround")
            : localizedSpeech(languageRef.current, "blurScreen");
        log("cadrage", m, scores);
        void sp.say(m);
      } else log("tu", "Écran illisible", scores);
      return;
    }

    // Dans une fiction, rien n'est écrit à l'écran : après un long silence, on décrit quand même la scène.
    // Dans la rue, on décrit les alentours après 12 s de silence ; devant un écran, après 25 s.
    const quietFor = t0 - lastSpeechEnd.current;
    const sceneTime =
      md === "monde" ? quietFor >= C.sceneAfterMonde : v.nature === "scene" && quietFor >= C.sceneAfter;
    const minImportant = md === "monde" ? C.importantMinMonde : C.importantMin;
    // Dans la rue, l'intérêt estimé ne doit pas jeter une lecture avant même sa vérification.
    // Le conteur, l'anti-répétition et le vérificateur restent obligatoires.
    if (md !== "monde" && ((v.important < minImportant && !sceneTime) || (v.nature === "rien" && !sceneTime))) {
      abortSpec();
      log("tu", "Rien de nouveau à dire", scores);
      return;
    }

    const d = spec ? await spec.p : await request<Description>("/api/describe", describeBody, deadline);
    if (gone()) return;
    if (!d.texte || d.certitude < C.certMin) {
      log("tu", `Description incertaine : « ${d.texte} »`, `${scores}, certitude ${pct(d.certitude)}`);
      return;
    }
    const repeatSpan = md === "monde" ? C.repeatWindowMonde : C.repeatWindow;
    const dup = spoken.current.some((s) => t0 - s.t < repeatSpan && overlap(d.texte, s.text) >= C.repeatOverlap) ||
      rejected.current.some((s) => t0 - s.t < rejectedSpan && overlap(d.texte, s.text) >= C.repeatOverlap);
    if (dup) {
      log("tu", `Déjà dit : « ${d.texte} »`, scores);
      return;
    }
    // La voix est lancée côté serveur dès maintenant, en parallèle de la vérification.
    const voiceId = sp.preparationEnabled ? sp.prepare(d.texte) : null;
    // Une action va trop vite pour attendre le vérificateur : elle part tout de suite. Les textes lus restent vérifiés.
    const ver: Verification =
      md === "ecran" && v.nature === "action"
        ? { conforme: 1, source: v.source, ms: 0 }
        : await request<Verification>("/api/verify", { image: big, texte: d.texte, mode: md, language: languageRef.current }, deadline);
    if (gone()) return;
    // Dans la rue, une description d'alentours (« un tram à droite ») est moins certaine qu'un texte lu :
    // seuil plus bas, mais les fausses affirmations restent bien en dessous (mesuré : 0,0 à 0,15).
    const verifyMin = (md === "monde" && v.nature === "scene") || v.nature === "action" ? C.verifyMinMonde : C.verifyMin;
    if (ver.conforme < verifyMin) {
      rejected.current = [...rejected.current, { text: d.texte, t: t0 }].slice(-6);
      log("tu", `Vérification échouée : « ${d.texte} »`, `${scores}, conformité ${pct(ver.conforme)}`);
      return;
    }
    // Avec deux analyses en parallèle, une plus ancienne peut finir après une plus récente : on la jette.
    if (t0 < newestQueued.current) {
      log("tu", `Dépassé par une image plus récente : « ${d.texte} »`, scores);
      return;
    }
    newestQueued.current = t0;
    pending.current = {
      text: d.texte,
      nature: v.nature,
      mode: md,
      voiceId: voiceId ?? sp.prepare(d.texte),
      priority: v.priorite,
      grid,
      triggeredAt: t0,
      queuedAt: Date.now(),
      detail: `${scores}, conteur ${d.ms} ms, vérification ${pct(ver.conforme)} en ${ver.ms} ms`,
    };
  }

  // Commentaire continu, comme à la radio. Deux rédactions tournent en parallèle, décalées d'au moins 1 s :
  // quand l'une retombe sur une phrase déjà dite, l'autre a souvent du neuf. Seule la plus récente est dite,
  // et rien de plus vieux que 4 s. Pas de juge ni de vérificateur ici : ils ajoutaient de l'attente.
  async function commentaryLoop(sid: number) {
    commentaryOn.current = sid;
    const sp = speaker.current;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const alive = () => sid === session.current && phaseRef.current === "narration";
    type Ready = { text: string; t0: number; ms: number; voiceId: Promise<string | null> };
    const box: { ready: Ready | null } = { ready: null }; // phrase en réserve, remplie par les rédactions
    let inflight = 0;
    let lastLaunch = 0;
    let lastAnalysisAt = 0;
    let lastVisualAt = 0;
    let visualGrid: Grid | null = null;
    let newestRetained = 0; // reste valable même quand la phrase en réserve a déjà été dite
    let reservedText = ""; // évite un doublon pendant que le premier son se prépare
    // Économie : quand le conteur n'a rien de neuf, on attend de plus en plus avant de relancer (1, 2, puis 4 s),
    // et on ne relance pas si l'image n'a presque pas bougé depuis la dernière rédaction.
    let backoff = C.commentaryStagger;
    let lastGrid: Grid | null = null;
    const isDup = (t: string, now: number) =>
      spoken.current.some((x) => now - x.t < C.repeatWindow && overlap(t, x.text) >= C.repeatOverlap) ||
      (reservedText !== "" && overlap(t, reservedText) >= C.repeatOverlap) ||
      (box.ready !== null && overlap(t, box.ready.text) >= C.repeatOverlap);

    const launch = async () => {
      const video = videoRef.current;
      if (!video) return;
      const g = captureGrid(video, 64, 36);
      if (g && lastGrid && backoff > C.commentaryStagger && Date.now() - lastAnalysisAt < C.forceNarration && gridDiff(lastGrid, g) < C.commentaryTextChange) {
        lastLaunch = Date.now(); // image immobile ; un contrôle forcé reste prévu au plus tard après 8 s
        return;
      }
      const img = captureJpeg(video, 768, 0.8);
      if (!img) return;
      if (g) lastGrid = g;
      inflight += 1;
      lastLaunch = Date.now();
      const t0 = Date.now();
      lastAnalysisAt = t0;
      const recent = [...recentTexts(), ...(reservedText ? [reservedText] : []), ...(box.ready ? [box.ready.text] : [])];
      try {
        const d = await request<Description>(
          "/api/describe",
          {
            image: img,
            recent,
            detail: detailRef.current,
            mode: "commentaire",
            vitesse: vitesseRef.current,
            language: languageRef.current,
            demoTime: demoRef.current ? video?.currentTime : undefined,
          },
          t0 + C.ttl,
        );
        if (!alive()) return;
        if (t0 <= newestRetained || Date.now() >= t0 + C.ttl) return;
        if (!d.texte || d.certitude < C.commentaryCertMin || isDup(d.texte, t0)) {
          backoff = Math.min(backoff * 2, C.commentaryMaxBackoff);
          log("tu", d.texte ? `Déjà dit : « ${d.texte} »` : "Rien de nouveau à dire", `conteur ${d.ms} ms, certitude ${pct(d.certitude)}`);
          return;
        }
        backoff = C.commentaryStagger;
        // La plus récente l'emporte : une image plus neuve remplace une phrase pas encore dite.
        newestRetained = t0;
        box.ready = { text: d.texte, t0, ms: d.ms, voiceId: sp.prepare(d.texte) };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof DOMException && e.name === "TimeoutError") {
          if (alive()) log("tu", "Analyse trop lente, image abandonnée.");
          return;
        }
        if (alive() && (message === "Code d'accès requis" || message === "Access code required")) {
          stop();
          const problem = accessProblem(languageRef.current);
          setProblem(problem);
          void speaker.current.say(`${problem.title}.`);
        } else if (alive()) {
          log("erreur", message);
        }
      } finally {
        inflight -= 1;
      }
    };

    try {
      while (alive()) {
        const now = Date.now();
        if (now - lastVisualAt >= C.tick) {
          lastVisualAt = now;
          const video = videoRef.current;
          visualGrid = video ? captureGrid(video, 64, 36) : null;
          if (visualGrid && lastGrid) {
            const change = gridDiff(lastGrid, visualGrid);
            if (change >= C.commentaryStill) backoff = C.commentaryStagger;
            else if (change >= C.commentaryTextChange) backoff = Math.min(backoff, C.commentaryTextEvery);
          }
        }
        // Le mouvement reprend sans attendre la fin du ralentissement ; un petit texte reste surveillé.
        const needMore = !box.ready || now - box.ready.t0 > C.commentaryFresh;
        const force = now - lastAnalysisAt >= C.forceNarration;
        if (needMore && inflight < 2 && (force || now - lastLaunch >= backoff)) void launch();
        // Parole : dès que la voix est libre, la phrase en réserve part.
        if (!sp.busy && box.ready) {
          const r: Ready = box.ready;
          box.ready = null;
          if (now - r.t0 > C.ttl) {
            log("tu", `Périmé : « ${r.text} »`, `${((now - r.t0) / 1000).toFixed(1)} s`);
            continue;
          }
          const turn = ++speechId.current;
          const voiceAlive = () => alive() && turn === speechId.current;
          reservedText = r.text;
          speakingNature.current = "action";
          speakingT0.current = r.t0;
          setSpeaking(true);
          const id = await Promise.race([r.voiceId, wait(250).then(() => null)]);
          if (!voiceAlive()) return;
          if (Date.now() >= r.t0 + C.ttl) {
            reservedText = "";
            setSpeaking(false);
            continue;
          }
          void sp
            .sayStream(
              r.text,
              () => {
                if (!voiceAlive()) return;
                const sec = (Date.now() - r.t0) / 1000;
                spoken.current = [...spoken.current, { text: r.text, t: Date.now() }].slice(-10);
                log("dit", r.text, `commentaire, conteur ${r.ms} ms, délai total ${sec.toFixed(1)} s`);
                setReaction(sec);
                remote("premier son", `${sec.toFixed(2)} s après l'image : ${r.text}`);
              },
              C.voiceWait,
              id,
              r.t0 + C.ttl,
            )
            .then((res) => {
              if (!voiceAlive()) return;
              reservedText = "";
              setSpeaking(false);
              if (res.error) log("tu", `Voix abandonnée : « ${r.text} »`, res.error);
              lastSpeechEnd.current = Date.now();
              setVoiceNote(res.via === "openai" ? (languageRef.current === "en" ? "OpenAI voice" : "voix OpenAI") : (languageRef.current === "en" ? "device voice" : "voix du téléphone"));
            });
          await wait(50); // laisse la voix se déclarer occupée
        }
        await wait(100);
      }
    } finally {
      if (commentaryOn.current === sid) commentaryOn.current = null;
    }
  }

  // Le cadrage est surveillé sans placer un juge devant chaque phrase du commentaire.
  async function checkScreen() {
    const sid = session.current;
    const state = screenCheck.current;
    const alive = () => sid === session.current && phaseRef.current === "narration" && modeRef.current === "ecran";
    if (!alive() || demoRef.current || state.sid !== null || Date.now() < state.next) return;
    const video = videoRef.current;
    const image = video ? captureJpeg(video, 768, 0.72) : null;
    if (!image) return;
    state.sid = sid;
    state.next = Date.now() + C.screenCheckEvery;
    try {
      const verdict = await request<Verdict>("/api/judge", { image, recent: [], mode: "ecran", language: languageRef.current }, Date.now() + C.voiceWait);
      if (!alive()) return;
      const framed = verdict.teleVisible >= 0.5 && verdict.inutilisable < C.unusableMin && (verdict.cadrage === "bon" || verdict.cadrage === "trop_loin");
      if (framed) { state.misses = 0; return; }
      state.misses += 1;
      if (state.misses < 2) {
        state.next = Date.now() + C.screenCheckConfirm;
        return;
      }
      invalidateWork();
      framingGood.current = 0;
      noScreen.current = 0;
      lastJudgedGrid.current = null;
      lastJudgeAt.current = 0;
      setPhaseBoth("cadrage");
      const key = verdict.teleVisible < 0.5 ? "pas_de_tele" : verdict.cadrage;
      const cue = verdict.inutilisable >= C.unusableMin ? localizedSpeech(languageRef.current, "blurScreen") : framingCue(languageRef.current, key);
      lastCueAt.current = Date.now();
      setCue(cue);
      log("cadrage", languageRef.current === "en" ? "Screen lost. Finding it again." : "Écran perdu, nouvelle recherche.");
      void speaker.current.say(cue);
    } catch (e) {
      if (!alive()) return;
      const message = e instanceof Error ? e.message : String(e);
      if (message === "Code d'accès requis" || message === "Access code required") {
        stop();
        setProblem(accessProblem(languageRef.current));
      }
      // Une erreur réseau n'est pas une preuve que l'écran a disparu.
    } finally {
      if (screenCheck.current === state) state.sid = null;
    }
  }

  // Boucle d'une image par seconde.
  async function tick() {
    const ph = phaseRef.current;
    if (ph !== "cadrage" && ph !== "narration") return;
    const video = videoRef.current;
    if (!video) return;
    const now = Date.now();
    const grid = modeRef.current === "monde" ? captureGrid(video, 64, 36) : captureGrid(video);
    if (!grid) {
      if (now - lastFrameAt.current > C.frameWatchdog && !warnedNoFrame.current) {
        warnedNoFrame.current = true;
        log("erreur", "Plus d'image de la caméra.");
        void speaker.current.say(localizedSpeech(languageRef.current, "noFrame"));
      }
      return;
    }
    lastFrameAt.current = now;
    warnedNoFrame.current = false;
    // Un vrai capteur a toujours un peu de bruit : des images strictement identiques veulent dire caméra figée.
    const prev = prevGrid.current;
    prevGrid.current = grid;
    if (prev && prev.length === grid.length && !demoRef.current) {
      let sum = 0;
      for (let i = 0; i < grid.length; i++) sum += Math.abs(grid[i] - prev[i]);
      frozen.current = sum / grid.length < 0.01 ? frozen.current + 1 : 0;
      if (frozen.current >= C.frozenTicks) {
        frozen.current = 0;
        void restartCamera("image figée");
        return;
      }
    }
    // Devant un écran, une fois l'écran trouvé : commentaire continu, comme à la radio.
    if (ph === "narration" && modeRef.current === "ecran") {
      void checkScreen();
      if (commentaryOn.current !== session.current) void commentaryLoop(session.current);
      return;
    }
    const ref = lastJudgedGrid.current;
    const ch = ref && ref.length === grid.length ? gridDiff(ref, grid) : 1;
    if (inFlight.current >= C.parallel) return;
    const since = now - lastJudgeAt.current;
    if (modeRef.current === "monde" && since < C.mondeEvery) return;
    const force = ph === "cadrage" ? since >= C.forceFraming : since >= (modeRef.current === "monde" ? C.mondeRefresh : C.forceNarration);
    const threshold = modeRef.current === "monde" ? C.commentaryTextChange : C.changeThreshold;
    if (ch < threshold && !force) return;
    inFlight.current += 1;
    const sid = session.current;
    lastJudgeAt.current = now;
    lastJudgedGrid.current = grid;
    try {
      await analyse(video, grid, ch, now);
    } catch (e) {
      if (sid !== session.current || phaseRef.current === "arret") return;
      if (e instanceof DOMException && e.name === "TimeoutError") {
        log("tu", "Analyse trop lente, image abandonnée.");
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Code d'accès requis" || msg === "Access code required") {
        // Sans code, rien ne peut marcher : on s'arrête et on explique.
        stop();
        const p = accessProblem(languageRef.current);
        setProblem(p);
        void speaker.current.say(`${p.title}.`);
        return;
      }
      log("erreur", msg);
    } finally {
      if (sid === session.current) inFlight.current = Math.max(0, inFlight.current - 1);
    }
  }

  // File d'une seule phrase : on parle si c'est encore vrai, et pas trop souvent.
  async function flush() {
    const p = pending.current;
    if (!p || flushing.current !== null || phaseRef.current !== "narration") return;
    const sid = session.current;
    const expiresAt = p.triggeredAt + C.ttl * (p.mode === "monde" || p.nature === "action" || p.nature === "scene" ? 1 : 2);
    const now = Date.now();
    if (now >= expiresAt) {
      pending.current = null;
      log("tu", `Périmé : « ${p.text} »`, p.detail);
      return;
    }
    const sp = speaker.current;
    if (sp.busy) {
      const nowSpeaking = speakingNature.current;
      const fresherAction = p.nature === "action" && (nowSpeaking === "action" || nowSpeaking === "scene") && p.triggeredAt > speakingT0.current;
      if ((nowSpeaking === "scene" && p.nature !== "scene") || fresherAction) {
        sp.cut();
        log("info", fresherAction ? "Action précédente coupée pour la plus récente." : "Description coupée pour une info plus importante.");
      } else return;
    }
    const minGap = p.mode === "monde" ? 0 : C.minGap;
    if (p.priority < C.urgent && now - lastSpeechEnd.current < minGap) return;
    const video = videoRef.current;
    const g = video ? captureGrid(video) : null;
    // En marchant, un déplacement global de la vue n'invalide pas à lui seul une information vérifiée.
    // La limite capture → son reste courte, y compris pour les enseignes et transports.
    if (p.mode !== "monde" && p.nature === "scene" && g && gridDiff(p.grid, g) > C.staleDiff) {
      pending.current = null;
      log("tu", `L'écran a changé avant de parler : « ${p.text} »`, p.detail);
      return;
    }
    pending.current = null;
    const turn = ++speechId.current;
    flushing.current = turn; // réserve le lecteur pendant l'attente de préparation
    const alive = () => sid === session.current && turn === speechId.current && phaseRef.current === "narration";
    setSpeaking(true);
    speakingNature.current = p.nature;
    speakingT0.current = p.triggeredAt;
    try {
      const preparedId = await Promise.race([p.voiceId, new Promise<null>((r) => setTimeout(() => r(null), 300))]);
      if (!alive() || Date.now() >= expiresAt || p.triggeredAt < newestQueued.current) return;
      const playback = sp.sayStream(p.text, () => {
        if (!alive()) return;
        const sec = (Date.now() - p.triggeredAt) / 1000;
        spoken.current = [...spoken.current, { text: p.text, t: Date.now() }].slice(-10);
        log("dit", p.text, `${p.detail}, délai total ${sec.toFixed(1)} s`);
        setReaction(sec);
        remote("premier son", `${sec.toFixed(2)} s après l'image : ${p.text}`);
      }, C.voiceWait, preparedId, expiresAt);
      // La lecture est maintenant occupée : une info urgente peut encore la couper.
      if (flushing.current === turn) flushing.current = null;
      const result = await playback;
      if (!alive()) return;
      if (result.error && /trop lente/.test(result.error)) log("tu", `Voix trop lente, phrase abandonnée : « ${p.text} »`, p.detail);
      else if (result.error && result.via === "telephone") log("erreur", "La voix OpenAI n'a pas joué, voix du téléphone utilisée.", result.error);
      lastSpeechEnd.current = Date.now();
      setVoiceNote(result.via === "openai" ? (languageRef.current === "en" ? "OpenAI voice" : "voix OpenAI") : (languageRef.current === "en" ? "device voice" : "voix du téléphone"));
    } finally {
      if (flushing.current === turn) flushing.current = null;
      if (alive()) {
        speakingNature.current = "";
        setSpeaking(false);
      }
    }
  }

  useEffect(() => {
    tickRef.current = () => void tick();
    mediaRef.current = { toggle: togglePause, stop };
    flushRef.current = () => void flush();
  });

  // Écran verrouillé ou appli quittée : on le signale à voix haute au retour.
  useEffect(() => {
    const onVis = () => {
      const ph = phaseRef.current;
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        if (ph === "narration" || ph === "cadrage") {
          hiddenResume.current = ph;
          resumePhase.current = ph;
          invalidateWork();
          setPhaseBoth("pause");
          if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused";
        }
        return;
      }
      if (ph === "arret") return;
      void requestWakeLock();
      const was = hiddenAt.current;
      hiddenAt.current = null;
      const resume = hiddenResume.current;
      hiddenResume.current = null;
      if (resume) {
        invalidateWork();
        lastJudgedGrid.current = null;
        setPhaseBoth(resume);
        if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
      }
      const track = streamRef.current?.getVideoTracks()[0];
      if (track && track.readyState === "ended" && !demoRef.current) {
        void restartCamera("retour au premier plan");
      }
      if (resume && was && Date.now() - was > 1500) {
        log("info", "Murmure était en pause pendant que l'écran était caché.");
        void speaker.current.say(localizedSpeech(languageRef.current, "resumeAfterHidden"));
      }
    };
    // Page quittée ou fermée : on rend la caméra tout de suite.
    const onHide = () => {
      const ph = phaseRef.current;
      if (ph === "narration" || ph === "cadrage") {
        hiddenResume.current = ph;
        resumePhase.current = ph;
        setPhaseBoth("pause");
      }
      invalidateWork();
      cameraEpoch.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // VoiceOver : au démarrage, le curseur va sur Pause ; à l'arrêt, sur le premier mode.
  const isRunning = phase !== "arret";
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!isRunning && !wasRunning.current) return; // premier chargement : on ne déplace rien
    wasRunning.current = isRunning;
    const target = isRunning ? pauseBtnRef.current : firstStartRef.current;
    const id = window.setTimeout(() => target?.focus(), 300);
    return () => window.clearTimeout(id);
  }, [isRunning]);

  useEffect(
    () => () => {
      session.current += 1;
      cameraEpoch.current += 1;
      for (const ctrl of requests.current) ctrl.abort();
      requests.current.clear();
      speaker.current.stop();
      timers.current.forEach((t) => window.clearInterval(t));
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void wakeRef.current?.release().catch(() => {});
    },
    [],
  );

  const running = phase !== "arret";
  const clock = (t: number) => new Date(t).toLocaleTimeString(language === "en" ? "en-US" : "fr-FR", { hour: "2-digit", minute: "2-digit" });
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const said = entries.filter((e) => e.kind === "dit");
  const comments = said.slice(0, 4).reverse();
  const showSoundTip = running && elapsed < 20;
  const accessIssue: Problem | null =
    access === "missing"
      ? accessProblem(language)
      : access === "wrong"
        ? { title: t(language, "wrongCodeTitle"), body: t(language, "wrongCodeBody") }
        : access === "nokey"
          ? { title: t(language, "noKeyTitle"), body: t(language, "noKeyBody") }
          : access === "down"
            ? { title: t(language, "serverDownTitle"), body: t(language, "serverDownBody") }
            : null;
  const visibleProblem = accessIssue ?? (problem?.kind === "access" ? accessProblem(language) : problem);
  const canStart = access === "ok";

  return (
    <main className={running ? "app is-running" : "app"}>
      {!running && (
        <header className="top">
          <span className="brand">
            Murmure<span className="brand-dot" aria-hidden="true" />
          </span>
          <label className="language-pick">
            <span>{t(language, "language")}</span>
            <select value={language} onChange={(e) => chooseLanguage(e.target.value)} aria-label={t(language, "language")}>
              <option value="fr">{t(language, "french")}</option>
              <option value="en">{t(language, "english")}</option>
            </select>
          </label>
        </header>
      )}

      {!running && (
        <section className="home" aria-label={t(language, "home")}>
          <div className="home-top">
          <div className="hero">
            <h1>{t(language, "heroTitle")}</h1>
            <p className="hero-line">{t(language, "heroLine")}</p>
            <p className="hero-stat">{t(language, "statShort")}</p>
          </div>

          {visibleProblem && (
            <div className="notice is-error" role="alert">
              <strong>{visibleProblem.title}</strong>
              <p>{visibleProblem.body}</p>
            </div>
          )}
          {access === "checking" && <p className="checking">{t(language, "checkingAccess")}</p>}
          </div>

          <div className="home-middle">
          <div className="settings-card" aria-label={t(language, "settings")}>
            {cams.length === 0 ? (
              <button className="setting-row setting-button" onClick={() => void askCams()} aria-label={t(language, "chooseCamera")}>
                <span>{t(language, "camera")}</span>
                <span className="setting-value">
                  {t(language, "chooseCamera")}
                  <Arrow />
                </span>
              </button>
            ) : (
              <label className="setting-row">
                <span>{t(language, "camera")}</span>
                <select value={camId} onChange={(e) => chooseCam(e.target.value)}>
                  <option value="">{t(language, "autoCamera")}</option>
                  {cams.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="setting-row" role="group" aria-label={t(language, "speed")}>
              <span>{t(language, "speed")}</span>
              <div className="seg">
                <button aria-pressed={vitesse === "eco"} onClick={() => chooseVitesse("eco")} aria-label={t(language, "economicalAria")}>
                  {t(language, "economical")}
                </button>
                <button aria-pressed={vitesse === "rapide"} onClick={() => chooseVitesse("rapide")} aria-label={t(language, "fastAria")}>
                  {t(language, "fast")}
                </button>
              </div>
            </div>
          </div>

          <button className="demo-button" onClick={startDemo} disabled={!canStart}>
            {t(language, "demo")}
            <Arrow />
          </button>

          </div>

          <div className="home-foot">
          <div className="modes">
            <button
              ref={firstStartRef}
              className="mode mode-main"
              onClick={() => void start("ecran")}
              disabled={!canStart}
              aria-label={t(language, "screenModeAria")}
            >
              <span className="mode-icon" aria-hidden="true">
                <i />
                <i />
                <b />
              </span>
              <span className="mode-text">
                <span className="mode-title">{t(language, "screenMode")}</span>
                <span className="mode-sub">{t(language, "screenModeSub")}</span>
              </span>
              <Arrow />
            </button>

            <button className="mode" onClick={() => void start("monde")} disabled={!canStart} aria-label={t(language, "aroundModeAria")}>
              <span className="mode-icon mode-icon-around" aria-hidden="true">
                <b />
              </span>
              <span className="mode-text">
                <span className="mode-title">{t(language, "aroundMode")}</span>
                <span className="mode-sub">{t(language, "aroundModeSub")}</span>
              </span>
              <Arrow />
            </button>
          </div>

          <p className="fine">{t(language, "privacy")}</p>
          </div>
        </section>
      )}

      <section className={running ? "live" : "live hidden"} aria-label={t(language, "live")}>
        <video ref={videoRef} className={demoVideo ? "cam is-contain" : "cam"} playsInline muted aria-hidden="true" />

        <p className="sr-only">
          {mode === "monde" ? t(language, "liveAround") : t(language, "liveScreen")}
        </p>
        <div className="hud-top" aria-hidden="true">
          <span className="chip">
            <span className={`rec rec-${phase}`} aria-hidden="true" />
            <Digits value={elapsed} language={language} />
          </span>
          <span className="chip">
            {demoVideo ? t(language, "demoLabel") : mode === "monde" ? (phase === "pause" ? t(language, "paused") : t(language, "aroundMode")) : PHASE_LABEL[phase][language]}
            {reaction !== null && <span className="chip-reaction">{reaction.toFixed(1).replace(language === "fr" ? "." : ",", language === "fr" ? "," : ".")} s</span>}
          </span>
        </div>

        {/* Journal discret, en petit dans le coin, comme les infos d'un live. */}
        <ol className="minilog" aria-hidden="true">
          {entries.slice(0, 4).map((e) => (
            <li key={e.id} className={`k-${e.kind}`}>
              <b>{KIND_LABEL[e.kind][language]}</b> {e.text}
            </li>
          ))}
          {(judgeSource || voiceNote) && (
            <li className="minilog-voice">
              {[judgeSource && `${t(language, "judge")}: ${judgeSource}`, voiceNote && `${t(language, "voice")}: ${voiceNote}`, vitesse === "rapide" ? t(language, "fast") : t(language, "economical")]
                .filter(Boolean)
                .join(" · ")}
            </li>
          )}
        </ol>


        <div className="hud-bottom">
          <div className="hud-notes">
            {phase === "cadrage" && cue && <p className="note note-strong">{cue}</p>}
            {running && mode === "monde" && elapsed < 20 && (
              <p className="note">{t(language, "protect")}</p>
            )}
            {showSoundTip && (
              <p className="note">{t(language, "noSound")}</p>
            )}
            {simulation && <p className="note">{t(language, "simulation")}</p>}
          </div>
          {comments.length > 0 && <p className="sr-only">{t(language, "lastPhrase", { phrase: comments[comments.length - 1].text })}</p>}
          <ol className="comments" aria-hidden="true">
            {comments.map((e, i) => {
              const latest = i === comments.length - 1;
              return (
                <li key={e.id} className={latest ? "is-latest" : ""}>
                  <span className="c-meta">
                    {latest && speaking ? <span className="c-live">{t(language, "speaking")}</span> : clock(e.t)}
                  </span>
                  <span className="c-text">{e.text}</span>
                </li>
              );
            })}
          </ol>
          {comments.length === 0 && phase === "narration" && (
            <p className="c-empty">
              {mode === "monde"
                ? t(language, "lookingAround")
                : t(language, "lookingScreen")}
            </p>
          )}

          <div className="hud-keys">
            {cams.length > 1 && !demoVideo ? (
              <button className="hk" onClick={() => void nextCam()} aria-label={t(language, "nextCamera")}>
                {t(language, "camera")}
              </button>
            ) : (
              <span />
            )}
            <button
              ref={pauseBtnRef}
              className="hk hk-main"
              onClick={togglePause}
              aria-label={phase === "pause" ? t(language, "resume") : t(language, "pause")}
            >
              {phase === "pause" ? t(language, "resumeShort") : t(language, "pauseShort")}
            </button>
            <button className="hk hk-stop" onClick={stop} aria-label={t(language, "stop")}>
              <span className="stop-square" aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

// Chronomètre : les zéros de tête restent gris, comme sur un cadran.
function Digits({ value, language }: { value: number; language: Language }) {
  const text = `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  const lead = text.match(/^[0:]*/)?.[0] ?? "";
  const keep = lead.length === text.length ? lead.length - 1 : lead.length;
  return (
    <span className="digits" aria-label={t(language, "elapsed", { minutes: Math.floor(value / 60), seconds: value % 60 })}>
      <span className="digits-dim">{text.slice(0, keep)}</span>
      {text.slice(keep)}
    </span>
  );
}

function Arrow() {
  return (
    <svg className="arrow" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}
