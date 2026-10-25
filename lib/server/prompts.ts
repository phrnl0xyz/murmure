import type { DecisionQuestion } from "./openai";
import { normalizeLanguage, type Language } from "../language";

/** « ecran » : le téléphone est posé face à un écran. « monde » : la personne marche, téléphone contre la poitrine. */
export type Mode = "ecran" | "monde" | "commentaire";

export const NATURES = [
  "carte_meteo",
  "bandeau_ou_texte",
  "score_ou_resultat",
  "nom_de_personne_ou_lieu",
  "graphique",
  "publicite",
  "scene",
  "action",
  "enseigne_ou_lieu",
  "panneau",
  "transport",
  "rien",
] as const;

export const CADRAGES = ["bon", "trop_a_gauche", "trop_a_droite", "trop_haut", "trop_bas", "trop_loin", "pas_de_tele"] as const;

export function contextText(recent: string[], mode: Mode = "ecran", language: Language = "fr"): string {
  if (normalizeLanguage(language) === "en") {
    const previous = recent.length ? recent.map((r) => `“${r}”`).join("; ") : "nothing yet";
    const scene = mode === "monde"
      ? "Photo taken by a blind person walking outdoors, holding the phone against their chest. "
      : "Photo taken by a phone facing a television, for a blind person watching TV. ";
    return `${scene}Phrases recently spoken to the person: ${previous}.`;
  }
  const deja = recent.length ? recent.map((r) => `« ${r} »`).join(" ; ") : "rien pour l'instant";
  const scene =
    mode === "monde"
      ? "Photo prise par le téléphone d'une personne aveugle qui marche dehors, téléphone tenu contre la poitrine. "
      : "Photo prise par un téléphone posé face à une télévision, pour une personne aveugle qui regarde la télé. ";
  return scene + `Phrases déjà chuchotées à la personne récemment : ${deja}.`;
}

export const JUDGE_QUESTIONS: DecisionQuestion[] = [
  {
    type: "predicate",
    name: "tele_visible",
    instructions:
      "Un écran de télévision allumé, ou un écran qui diffuse une image, est-il visible dans la photo, même s'il est un peu coupé par les bords ?",
  },
  {
    type: "choice",
    name: "cadrage",
    instructions: "Où se trouve l'écran de télévision dans la photo ?",
    choices: [
      { value: "bon", description: "L'écran est visible et son contenu est lisible, même s'il déborde un peu des bords ou s'il remplit toute la photo." },
      { value: "trop_a_gauche", description: "Une grande partie de l'écran, au moins un tiers, sort par le bord gauche de la photo." },
      { value: "trop_a_droite", description: "Une grande partie de l'écran, au moins un tiers, sort par le bord droit de la photo." },
      { value: "trop_haut", description: "Une grande partie de l'écran, au moins un tiers, sort par le bord haut de la photo." },
      { value: "trop_bas", description: "Une grande partie de l'écran, au moins un tiers, sort par le bord bas de la photo." },
      { value: "trop_loin", description: "L'écran est si petit dans la photo que son texte est illisible." },
      { value: "pas_de_tele", description: "Aucun écran n'est visible." },
    ],
  },
  {
    type: "predicate",
    name: "image_inutilisable",
    instructions: "Le contenu de l'écran est-il illisible à cause d'un reflet, d'un flou, ou parce que l'écran est noir ou éteint ?",
  },
  {
    type: "predicate",
    name: "changement_important",
    instructions:
      "L'écran montre-t-il une information visuelle nouvelle et utile, absente des phrases déjà chuchotées, que le son de la télé ne donne probablement pas ? " +
      "Exemples : carte météo, alerte, bandeau de titre, score, nom d'une personne interviewée, graphique, nouveau lieu. " +
      "Compte aussi comme important une action nouvelle : tir, occasion, but, arrêt du gardien, faute, carton, célébration, entrée des joueurs, et dans un film un geste qui fait avancer l'histoire. " +
      "Ignorer le bandeau défilant habituel des chaînes d'information sauf s'il annonce une alerte. Ignorer le logo de la chaîne et l'heure. " +
      "Ignorer les petits gestes sans conséquence (quelqu'un qui marche, sourit ou attend) et la même action qui continue.",
  },
  {
    type: "choice",
    name: "nature",
    instructions: "Quelle est la nature principale de l'information nouvelle à l'écran ?",
    choices: [
      { value: "carte_meteo", description: "Carte ou bulletin météo, vigilance." },
      { value: "bandeau_ou_texte", description: "Titre, bandeau, texte affiché, flash info." },
      { value: "score_ou_resultat", description: "Score sportif, résultat, classement, prix." },
      { value: "nom_de_personne_ou_lieu", description: "Nom et fonction d'une personne, nom d'un lieu." },
      { value: "graphique", description: "Graphique, tableau, chiffres." },
      { value: "publicite", description: "Publicité." },
      { value: "action", description: "Action importante en cours : tir, but, occasion, faute, carton, célébration, geste qui fait avancer l'histoire." },
      { value: "scene", description: "Nouveau lieu ou nouvelle séquence." },
      { value: "rien", description: "Rien de nouveau ou d'utile." },
    ],
  },
  {
    type: "score",
    name: "priorite",
    instructions: "À quel point est-il urgent de dire à une personne aveugle ce qui est à l'écran ?",
    levels: [
      { label: "Peut attendre", description: "Information utile mais sans urgence." },
      { label: "Dès que possible", description: "Information importante pour comprendre ce qui se dit." },
      { label: "Immédiat", description: "Alerte météo, vigilance, flash info, consigne de sécurité, but ou célébration." },
    ],
  },
];

// Dans la rue : pas de recherche d'écran. On cherche ce qui est écrit et ce qui aide à se repérer.
export const JUDGE_QUESTIONS_MONDE: DecisionQuestion[] = [
  {
    type: "predicate",
    name: "image_inutilisable",
    instructions:
      "La photo est-elle inutilisable : très floue à cause du mouvement, trop sombre, ou cachée par un doigt, un vêtement ou une poche ?",
  },
  {
    type: "predicate",
    name: "changement_important",
    instructions:
      "La photo montre-t-elle quelque chose de nouveau qu'une personne aveugle aimerait savoir, absent des phrases déjà chuchotées ? " +
      "Exemples : le lieu où elle se trouve (rue, terrasse de café, gare, magasin, parc), un bus ou un tram qui arrive, un objet posé juste devant elle, " +
      "un texte, une enseigne, un panneau, une plaque de rue, une entrée de métro. " +
      "Répondre non si seul l'angle du téléphone a changé, sans rien de nouveau autour."
  },
  {
    type: "choice",
    name: "nature",
    instructions: "Quelle est la nature principale de l'information nouvelle ?",
    choices: [
      { value: "enseigne_ou_lieu", description: "Nom d'un magasin, d'un restaurant, d'un bâtiment, d'un lieu." },
      { value: "panneau", description: "Panneau, plaque de rue, affiche, texte écrit, horaires." },
      { value: "transport", description: "Bus et son numéro, arrêt, station de métro, gare, tram." },
      { value: "scene", description: "Le lieu ou ce qui se passe autour : rue, terrasse, place, objet devant la personne." },
      { value: "rien", description: "Rien de nouveau ou d'utile." },
    ],
  },
  {
    type: "score",
    name: "priorite",
    instructions: "À quel point est-il urgent de le dire à une personne aveugle qui marche ?",
    levels: [
      { label: "Peut attendre", description: "Repère utile sans urgence, comme un magasin." },
      { label: "Utile maintenant", description: "Bus qui arrive, arrêt, entrée de station, plaque de rue." },
      { label: "Immédiat", description: "Panneau de travaux, trottoir fermé, avertissement écrit." },
    ],
  },
];

const JUDGE_QUESTIONS_EN: DecisionQuestion[] = [
  { type: "predicate", name: "tele_visible", instructions: "Is a lit television or display showing an image visible in the photo, even if partly cut off by the edges?" },
  { type: "choice", name: "cadrage", instructions: "Where is the television screen in the photo?", choices: [
    { value: "bon", description: "The screen is visible and its content is readable, even if it extends beyond the edges or fills the photo." },
    { value: "trop_a_gauche", description: "At least a third of the screen extends past the left edge." }, { value: "trop_a_droite", description: "At least a third of the screen extends past the right edge." },
    { value: "trop_haut", description: "At least a third of the screen extends past the top edge." }, { value: "trop_bas", description: "At least a third of the screen extends past the bottom edge." },
    { value: "trop_loin", description: "The screen is too small in the photo for its text to be read." }, { value: "pas_de_tele", description: "No screen is visible." },
  ] },
  { type: "predicate", name: "image_inutilisable", instructions: "Is the screen content unreadable because of glare, blur, or because the screen is black or turned off?" },
  { type: "predicate", name: "changement_important", instructions: "Does the screen show new, useful visual information not present in recent phrases and probably not conveyed by the TV audio? Examples: a weather map or alert, headline, score, interviewee name, chart, new location, or important action such as a shot, goal, save, foul, card, or celebration. Ignore routine tickers unless they announce an alert, channel logos, the clock, small inconsequential gestures, and an action that simply continues." },
  { type: "choice", name: "nature", instructions: "What is the main type of new information on screen?", choices: [
    { value: "carte_meteo", description: "Weather map, forecast, or warning." }, { value: "bandeau_ou_texte", description: "Headline, ticker, displayed text, or breaking news." },
    { value: "score_ou_resultat", description: "Sports score, result, ranking, or price." }, { value: "nom_de_personne_ou_lieu", description: "Person and role, or place name." },
    { value: "graphique", description: "Chart, table, or figures." }, { value: "publicite", description: "Advertisement." },
    { value: "action", description: "Important action: shot, goal, chance, foul, card, celebration, or story-changing gesture." }, { value: "scene", description: "New place or sequence." }, { value: "rien", description: "Nothing new or useful." },
  ] },
  { type: "score", name: "priorite", instructions: "How urgently should a blind person be told what is on screen?", levels: [
    { label: "Can wait", description: "Useful information without urgency." }, { label: "As soon as possible", description: "Important context." }, { label: "Immediate", description: "Weather warning, breaking news, safety instruction, goal, or celebration." },
  ] },
];

const JUDGE_QUESTIONS_MONDE_EN: DecisionQuestion[] = [
  { type: "predicate", name: "image_inutilisable", instructions: "Is the photo unusable because it is very motion-blurred, too dark, or blocked by a finger, clothing, or a pocket?" },
  { type: "predicate", name: "changement_important", instructions: "Does the photo show something new a blind person would want to know, not covered by recent phrases? Examples: the place (street, cafe terrace, station, shop, park), an approaching bus or tram, an object directly ahead, text, a business sign, street sign, or metro entrance. Answer no if only the phone angle changed." },
  { type: "choice", name: "nature", instructions: "What is the main type of new information?", choices: [
    { value: "enseigne_ou_lieu", description: "Name of a shop, restaurant, building, or place." }, { value: "panneau", description: "Sign, street plate, poster, written text, or opening hours." },
    { value: "transport", description: "Bus and number, stop, metro station, train station, or tram." }, { value: "scene", description: "The place or surroundings: street, terrace, square, or an object ahead." }, { value: "rien", description: "Nothing new or useful." },
  ] },
  { type: "score", name: "priorite", instructions: "How urgently should this be said to a blind person who is walking?", levels: [
    { label: "Can wait", description: "Useful landmark, such as a shop." }, { label: "Useful now", description: "Approaching bus, stop, station entrance, or street sign." }, { label: "Immediate", description: "Roadworks sign, closed sidewalk, or written warning." },
  ] },
];

export const judgeQuestions = (mode: Mode, language: Language = "fr") => {
  if (normalizeLanguage(language) === "en") return mode === "monde" ? JUDGE_QUESTIONS_MONDE_EN : JUDGE_QUESTIONS_EN;
  return mode === "monde" ? JUDGE_QUESTIONS_MONDE : JUDGE_QUESTIONS;
};

export function describeInstructions(detail: "sobre" | "detaille", recent: string[], mode: Mode = "ecran", language: Language = "fr"): string {
  const max = detail === "sobre" ? 6 : 14; // court : dit vite, avant que l'image change
  const deja = recent.length ? recent.map((r) => `« ${r} »`).join(" ; ") : "rien";
  if (normalizeLanguage(language) === "en") {
    const previous = recent.length ? recent.map((r) => `“${r}”`).join("; ") : "nothing";
    if (mode === "commentaire") return "You are a live radio commentator for a blind person watching a screen: a match, show, or film. Narrate continuously in real time. " +
      `In English, in the present tense, write one vivid sentence of no more than ${max + 3} words about what is newly happening since your last phrases. ` +
      "Prioritize important on-screen text (score, name, game time, title), then the action (who has the ball, shot, pass, goal, foul, save, celebration), then the location. Identify players by shirt number or color; use a name only if written on screen. " +
      "Follow the ball and the game situation, not small gestures. Do not describe the same person twice in a row or mention inconsequential gestures. Each phrase must add new information. Never mention the camera or framing. Continue naturally without repeating previous phrases. No symbols. Never say ‘I see’. If nothing has truly changed, return an empty string. Do not invent anything. Recent phrases: " + previous + ".";
    if (mode === "monde") return "You are a companion guiding a blind person outdoors, telling them what is around them. Their phone camera faces forward. " +
      `In English, write one natural sentence of no more than ${max + 3} words about something new and useful, in this priority order: an approaching bus or tram, written text or sign, business sign, place, object directly ahead. ` +
      "If no phrase has been spoken yet or the place has changed, start by naming the place. Read names and numbers exactly as written. Use exactly one position at the end: ‘on your left’, ‘on your right’, or ‘ahead’. Never describe pedestrians or their appearance. Never say that it is safe or possible to cross, or that a path is clear. " +
      "For a poster, read its most visible title in full, word for word. Do not guess words cut off by the image edge. No symbols. Never say ‘I see’. If unsure, do not invent and lower confidence. Do not repeat: " + previous + ".";
    return "You are speaking into the ear of a blind person watching a screen: television, computer, or tablet. " +
      `Describe in English, in the present tense, in no more than ${max} words, only what is newly visible and probably not conveyed by the audio. ` +
      "Read numbers, names, places, and alerts exactly as written. Start with the essential information. Never say ‘I see’, ‘the image shows’, or ‘on screen’. No dashes, arrows, or symbols. Ignore channel logos, the clock, and ordinary scrolling tickers. For people on screen, give name and role only if written; never describe clothing or appearance. Narrate important sports action like a radio commentator. Important text comes first. Ignore inconsequential gestures. Name a team or player only if written on screen; otherwise use shirt color or number. Say only what just changed. If unsure, do not invent and lower confidence. Do not repeat: " + previous + ".";
  }
  if (mode === "commentaire") {
    return (
      "Tu es le commentateur radio d'une personne aveugle qui regarde un écran : match, émission, film. Tu racontes en direct, en continu. " +
      `En français, au présent, en une phrase vivante de ${max + 3} mots maximum, dis ce qui se passe maintenant de nouveau depuis tes dernières phrases. ` +
      "Priorité : un texte important à l'écran (score, nom, temps de jeu, titre), puis l'action (qui a le ballon, tir, passe, but, faute, arrêt, célébration), puis le lieu. " +
      "Désigne les joueurs par leur numéro ou la couleur du maillot ; un nom seulement s'il est écrit à l'écran. " +
      "Suis le ballon et la situation de jeu (qui attaque, où, le danger), pas les petits gestes. " +
      "Ne décris jamais deux fois de suite la même personne ; ne raconte pas les gestes sans conséquence (se pencher, marcher, se redresser, ajuster ses lunettes). " +
      "Ta phrase doit apporter une information différente de tes dernières phrases. " +
      "Ne parle jamais de la caméra ni du cadrage (« la caméra montre », « gros plan sur ») : dis directement ce qui se passe. " +
      "Enchaîne avec tes phrases précédentes comme un vrai commentateur, sans les répéter. Pas de symboles. Jamais « je vois ». " +
      "Si rien n'a vraiment changé depuis ta dernière phrase, renvoie un texte vide. N'invente rien. " +
      `Tes dernières phrases : ${deja}.`
    );
  }
  if (mode === "monde") {
    return (
      "Tu es l'ami qui accompagne une personne aveugle dehors et tu lui dis à l'oreille ce qu'il y a devant elle. Son téléphone filme devant elle. " +
      `En français, en une phrase naturelle de ${max + 3} mots maximum, dis ce qui est nouveau et utile, dans cet ordre de priorité : ` +
      "un bus ou un tram qui arrive, un texte ou un panneau, une enseigne, le lieu, un objet juste devant elle. " +
      "Si aucune phrase n'a encore été dite, ou si le lieu a changé depuis les phrases déjà dites, commence par dire où elle est : « Tu es en terrasse de café », « Tu es sur un trottoir ». " +
      "Lis les noms et les chiffres exactement comme ils sont écrits. " +
      "Une seule indication de position, à la fin : « à gauche », « à droite » ou « devant ». Jamais deux, jamais « derrière la terrasse ». " +
      "Exemples : « Tu es en terrasse, un tram à droite. », « Verre de bière Vega, devant toi. », " +
      "« Boulangerie Paul, à droite. », « Bus 63, direction Gare de Lyon, devant. », « Panneau : trottoir fermé, devant. ». " +
      "Pour une affiche, lis son titre le plus visible en entier, mot pour mot, sans couper la phrase. " +
      "Exemple : « Affiche : Demain, une gare plus fluide, à droite. ». " +
      "Ne devine jamais la fin d'un mot coupé par le bord de l'image. " +
      "Ne décris jamais les passants ni leur apparence. Ne dis jamais qu'on peut traverser, ni qu'un chemin est libre ou sûr. " +
      "La phrase sera lue à voix haute : pas de symboles. Jamais « je vois ». " +
      "Si tu n'es pas sûr de ce que tu lis, n'invente rien et baisse la certitude. " +
      `Ne répète pas ces phrases déjà dites : ${deja}.`
    );
  }
  return (
    "Tu chuchotes à l'oreille d'une personne aveugle qui regarde un écran : télévision, ordinateur ou tablette. " +
    `Décris en français, au présent, en ${max} mots maximum, uniquement ce que l'écran montre de nouveau et que le son ne dit probablement pas. ` +
    "Lis les chiffres, les noms, les lieux et les alertes exactement comme ils sont écrits. " +
    "Commence par l'essentiel. Si ça aide à comprendre, nomme d'abord le type d'écran en deux mots, par exemple « Carte météo. » ou « Score. ». " +
    "Jamais « je vois », « l'image montre » ou « à l'écran ». " +
    "La phrase sera lue à voix haute : pas de tirets, de flèches ni de symboles. Un score s'écrit « PSG 2, OM 1 ». " +
    "Ignore le logo de la chaîne, l'heure et le bandeau défilant ordinaire. " +
    "Pour une personne à l'écran, donne son nom et son rôle s'ils sont écrits, jamais ses vêtements ni son apparence. " +
    "Raconte l'action comme un commentateur radio, au présent, en peu de mots, avec le numéro ou le nom du joueur s'il est visible : " +
    "« Le 10 frappe, arrêt du gardien. », « Carton jaune pour le 4. », « But du PSG, le 7 célèbre. ». " +
    "Si un texte important apparaît (score, temps de jeu, nom, banderole, statistique), il passe en premier. " +
    "Ignore les petits gestes sans conséquence. " +
    "Ne nomme une équipe ou un joueur que si son nom est écrit à l'écran. Sinon, désigne-les par la couleur du maillot ou le numéro : « les joueurs en rose célèbrent ». " +
    "Pour un jeu ou un score, dis seulement ce qui vient de changer. " +
    "Si tu n'es pas sûr de ce que tu lis, n'invente rien et baisse la certitude. " +
    `Ne répète pas ces phrases déjà dites : ${deja}.`
  );
}

export const DESCRIBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    texte: { type: "string", description: "La phrase à chuchoter." },
    certitude: { type: "number", description: "De 0 à 1, à quel point la phrase est sûre." },
  },
  required: ["texte", "certitude"],
};

export const VERIFY_QUESTION: DecisionQuestion = {
  type: "predicate",
  name: "conforme",
  instructions:
    "La phrase à vérifier décrit-elle fidèlement ce qui est affiché sur l'écran de télévision, y compris chaque chiffre, nom, lieu et mot lu, sans rien inventer ?",
};

export const VERIFY_QUESTION_EN: DecisionQuestion = {
  type: "predicate",
  name: "conforme",
  instructions: "Does the phrase accurately describe the television screen, including every number, name, place, and quoted word, without inventing anything?",
};

export const VERIFY_QUESTION_MONDE: DecisionQuestion = {
  type: "predicate",
  name: "conforme",
  instructions:
    "La phrase décrit-elle fidèlement ce que montre la photo ? Les lieux, objets et véhicules cités sont-ils bien visibles, et les noms, chiffres et textes cités sont-ils bien écrits sur la photo, sans rien inventer ? Une position approximative (à gauche, à droite, devant, de l'autre côté de la rue) est acceptable.",
};

export const VERIFY_QUESTION_MONDE_EN: DecisionQuestion = {
  type: "predicate",
  name: "conforme",
  instructions: "Does the phrase accurately describe what is visible in the photo? Are the places, objects, and vehicles visible, and are all quoted names, numbers, and text actually written in the photo, without inventing anything? Approximate positions such as left, right, or ahead are acceptable.",
};

/** Schéma de secours quand la Decisions API n'est pas accessible : Sol répond aux mêmes questions. */
export const JUDGE_FALLBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tele_visible: { type: "number" },
    cadrage: { type: "string", enum: [...CADRAGES] },
    image_inutilisable: { type: "number" },
    changement_important: { type: "number" },
    nature: { type: "string", enum: [...NATURES] },
    priorite: { type: "number" },
  },
  required: ["tele_visible", "cadrage", "image_inutilisable", "changement_important", "nature", "priorite"],
};

export function judgeFallbackInstructions(mode: Mode = "ecran", language: Language = "fr"): string {
  const english = normalizeLanguage(language) === "en";
  const lines = judgeQuestions(mode, language).map((q) => {
    if (q.type === "choice") return `- ${q.name}: ${q.instructions} Values: ${q.choices.map((c) => `${c.value} (${c.description})`).join(", ")}.`;
    if (q.type === "score") return `- ${q.name}: ${q.instructions} Number from 0 to 2: ${q.levels.map((l, i) => `${i} = ${l.label}`).join(", ")}.`;
    return `- ${q.name}: ${q.instructions} Probability from 0 to 1.`;
  });
  const extra = mode === "monde" ? (english ? "\n- tele_visible: answer 1.\n- cadrage: answer ‘bon’." : "\n- tele_visible : réponds 1.\n- cadrage : réponds « bon ».") : "";
  return (english ? "Answer every question about the photo.\n" : "Réponds à chaque question sur la photo.\n") + lines.join("\n") + extra;
}
