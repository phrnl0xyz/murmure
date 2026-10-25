# Murmure

**A live radio commentator for blind and low-vision people.**
Point your phone at the TV, or hold it against your chest in the street. Murmure watches through the camera and tells you, in your earbuds, what is happening: the action, the score, the names on screen, the signs around you.

Built for the OpenAI DevDay Community Hackathon Paris, October 2026. Tracks: Impact, Build in public.

## Why

1.7 million people in France live with a visual impairment. In front of a football match they hear the crowd explode, but not why. In front of the weather forecast, "red alert here" means nothing if you cannot see the map. Audio description exists for some films, almost never for live TV, and never for the street.

Murmure is a web page: no app to install, just a phone, its camera and earbuds.

## Two modes

**In front of a screen: continuous commentary.**
Murmure first finds the screen, then narrates like a radio commentator, sentence after sentence: who has the ball, a shot, a goal, a card, and anything important written on screen (score, names, banners).
While one sentence is being spoken, the next one is already being written from the newest frame, so there is no dead air.

**Around me: the street.**
Phone against the chest, Murmure names the place, buses and trams, store signs, street plates, notices and objects right in front of you, with a single direction: left, right or ahead.
It never describes passers-by and never says it is safe to cross. It does not replace a white cane or a guide dog, and it says so when it starts.
If no screen is visible for about 2 seconds in screen mode, it switches to this mode by itself.

## How it works

| Step | Model | Role |
|---|---|---|
| Judge | Decisions API, `gpt-6-luna` | Is there a screen? Is something new and worth saying? About 0.3 s. |
| Narrator | `gpt-6.1-sol`, low reasoning effort, 768 px frames | Writes one short sentence. About 1.5 s. |
| Verifier | Decisions API, `gpt-6-luna` | Checks the sentence against the image before it is spoken (street mode and on-screen text). |
| Voice | `gpt-4o-mini-tts`, voice `marin` | Generated on the server while the sentence is verified, then streamed to the phone. |

- **Camera only, no microphone.** On iPhone, opening the microphone in the browser disrupts audio output, especially with Bluetooth earbuds.
- **The phone does the cheap work.** It compares frames on a 16 × 9 grid, so a still image costs nothing.
- **Fallbacks.** If the Decisions API is unavailable, Sol answers the same questions in strict JSON. If streaming audio fails, the full audio file is used.
- **Hands-free.** A press on the AirPods stem pauses or resumes, and removing an earbud pauses. VoiceOver labels are set on every control.
- **Two languages.** The interface and the voice work in French and English.

## Measured, not guessed

**Narrator benchmark** on 12 real frames from our tests (`scripts/banc.py`):

| Narrator | Median time | Correct sentences |
|---|---|---|
| GPT-6.1 Sol, low effort (kept) | 1.6 s | 10 / 12 |
| GPT-4.1 mini | 1.5 s | 3 / 12 |
| GPT-5.6 Sol | 3.7 s | 6 / 12 |

**Live commentary on a real match**, 7 minutes:
- 110 sentences;
- a median gap of 0.5 s between two sentences;
- first sound about 3 s after the image.

**GPT-Live** was tested as the voice (`scripts/essai-gpt-live.mjs`). It read 10 sentences out of 10 word for word, but its first sound came 0.9 to 1.1 s after the text, and it cannot be prepared in advance. It was not faster than the prepared TTS voice, so it is kept for a future question mode.

## Cost

The narrator uses the `fast` service tier by default (« Économique », about $5.5 per hour of commentary). A « Rapide » setting switches to `ultrafast` (about $16 per hour, first sound about 0.5 s sooner). When the picture does not change, Murmure waits longer and longer before writing again.

## Privacy

- Frames are sent to OpenAI for analysis and are not stored by Murmure.
- No microphone is used.
- The OpenAI key stays on the server.
- API routes are protected by an access code (`MURMURE_CODE`). Open the app with `?code=...`, and the code is then remembered on the phone.

## Run it

```bash
npm install
cp env.example .env.local   # then set OPENAI_API_KEY and MURMURE_CODE
npm run dev
```

- **On a computer without a camera:** open `http://localhost:3000/?code=YOUR_CODE` and press « Voir la démo sans caméra ».
- **On iPhone,** the camera requires HTTPS. Use a tunnel such as `cloudflared tunnel --url http://localhost:3000`, or deploy on Vercel with the same environment variables.
- **Without an OpenAI key:** set `MURMURE_MOCK=1` for simulated answers.

## Limits

- **The first sound comes about 3 s after the image.** Writing the sentence takes about 1.5 s with today's fastest accurate model.
- **Street mode is for reading and orientation,** not for safety.
- **`gpt-4o-mini-tts` is marked as deprecated** by OpenAI.

## Built with

OpenAI models only: Decisions API (`gpt-6-luna`), GPT-6.1 Sol, `gpt-4o-mini-tts`, with GPT-Live evaluated.
The project was finished with OpenAI Codex.
Stack: Next.js 16, React 19, TypeScript.
