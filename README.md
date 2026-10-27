# Murmure

**A live radio commentator for blind and low-vision people.**
Point your phone at the TV, or hold it against your chest in the street. Murmure watches through the camera and tells you, in your earbuds, what is happening: the action, the score, the names on screen, the signs around you.

Built for the OpenAI DevDay Community Hackathon Paris, October 2026. Tracks: Impact, Build in public.

**Try it:** [murmure-devday.vercel.app](https://murmure-devday.vercel.app), on a phone with earbuds, with your own OpenAI key (BYOK, see below).

## Why

1.7 million people in France live with a visual impairment. In front of a football match they hear the crowd explode, but not why. In front of the weather forecast, "red alert here" means nothing if you cannot see the map. Audio description exists for some films, almost never for live TV, and never for the street.

Murmure is a web page: no app to install, just a phone, its camera and earbuds.

## Two modes

**In front of a screen: continuous commentary.**
Murmure first finds the screen, then narrates like a radio commentator, sentence after sentence: who has the ball, a shot, a goal, a card, and anything important written on screen (score, names, banners).
While one sentence is being spoken, the next one is already being written from a recent frame to shorten the gaps.

**Around me: the street.**
Phone against the chest, Murmure names the place, buses and trams, store signs, street plates, notices and objects right in front of you, with a single direction: left, right or ahead.
It never describes passers-by and never says it is safe to cross. It does not replace a white cane or a guide dog, and it says so when it starts.
Walking motion alone does not discard a verified landmark. Street scenes, actions and transport observations must begin playback within four seconds of their sampled frame; verified signs and place names have a six-second limit. Once a street phrase is selected, newer detections wait for that short phrase to finish rather than interrupt its loading or playback. Stop and pause still cancel it immediately.
Small visual changes can trigger a new street analysis. A periodic check is due after two seconds, subject to the two-request concurrency limit. A low relevance score from the judge does not suppress a candidate before the narrator and verifier check it; unreadable images, uncertain or repeated descriptions and failed verification still prevent speech.
The phone uploads each street frame once. The server runs the judge and narrator in parallel, then verifies the candidate using that same frame. This avoids sending the frame again over the mobile uplink for each step. It does not guarantee a four-second response on a weak connection.
If the screen is lost, Murmure checks the framing again and can switch to this mode when no screen is found.

## How it works

| Step | Model | Role |
|---|---|---|
| Judge | Decisions API, `gpt-6-luna` | Is there a screen? Is something new and worth saying? About 0.3 s. |
| Narrator | `gpt-6.1-sol`, low reasoning effort, 768 px frames | Writes one short sentence. About 1.5 s. |
| Verifier | Decisions API, `gpt-6-luna` | Checks sentences against the image in street mode and the judge-based path. Continuous screen commentary uses the narrator's confidence and freshness checks. |
| Voice | `gpt-4o-mini-tts`, voice `marin` | Direct streaming by default. The phone can preload one next phrase during a sufficiently long current playback. Local runs also support server voice preparation. |

- **Camera only, no microphone.** On iPhone, opening the microphone in the browser disrupts audio output, especially with Bluetooth earbuds.
- **The phone does the cheap work.** It compares frames locally, with a finer grid for small changes in screen commentary and street mode. Still pictures are checked less often, with a periodic refresh for new text.
- **Fallbacks.** If the Decisions API is unavailable, Sol answers the same questions in strict JSON. If streaming audio fails, the full audio file is used.
- **Stateless production audio.** Each audio request keeps its OpenAI stream in the same HTTP response. Production does not rely on a voice prepared in another server instance. Remote debug events are sent only when the server can record them locally.
- **Bounded phone preloading.** If the current playback has at least 1.5 seconds of known remaining audio, the phone can fetch one next phrase in advance and reuse the same unlocked audio element. Unknown or short durations keep direct streaming. Pending audio downloads are cancelled on stop or replacement. The benefit depends on the browser reporting a usable duration; it still needs an iPhone trial.
- **Headset controls.** Media Session exposes playback commands to compatible headsets. VoiceOver labels are set on every control; physical iPhone and AirPods validation is still needed for the latest changes.
- **Two languages.** The interface and the voice work in French and English.

## Measured, not guessed

**Narrator benchmark** on 12 real frames from our tests (`scripts/banc.py`):

| Narrator | Median time | Accepted by the verifier |
|---|---|---|
| GPT-6.1 Sol, low effort (kept) | 1.6 s | 10 / 12 |
| GPT-4.1 mini | 1.5 s | 3 / 12 |
| GPT-5.6 Sol | 3.7 s | 6 / 12 |

These are model-scored checks on still images, not independent human accuracy scores or a benchmark of continuous football commentary.

**Local live commentary on a real match**, 7 minutes, before the latest reliability changes:
- 110 sentences;
- a median gap of 0.5 s between two sentences;
- first sound about 3 s after the image.

**GPT-Live** was tested as the voice (`scripts/essai-gpt-live.mjs`). It read 10 sentences out of 10 word for word, but its first sound came 0.9 to 1.1 s after the text, and it cannot be prepared in advance. It was not faster than the prepared TTS voice, so it is kept for a future question mode.

## Cost

The narrator uses the `fast` service tier by default (« Économique »). Earlier local estimates were about $5.5 per hour of commentary, or $16 per hour with the optional `ultrafast` tier (« Rapide »). These are estimates, not metered costs for the current production build. When the picture does not change, Murmure slows its analyses but keeps a periodic check for new text.

## Privacy

- Frames are sent to OpenAI for analysis and are not stored by Murmure.
- No microphone is used.
- The server's OpenAI key stays on the server. A BYOK key stays in a cookie on your phone and is only used for your own requests.
- API routes need either the access code (`MURMURE_CODE`) or a BYOK key. Open the app with `?code=...`, and the code is then remembered on the phone.

## Try it with your own OpenAI key (BYOK)

BYOK means "Bring Your Own Key": you test Murmure on the public site with your own OpenAI API key, and your OpenAI account pays for the calls, about $5 per hour of use.

- Paste the key on the home screen. The server checks it with a free OpenAI call (`GET /v1/models`).
- The key is kept on your phone in an `HttpOnly`, `SameSite=Strict` cookie limited to `/api`. The page's JavaScript cannot read it, and it never appears in a URL.
- On each request, the server uses it only for that request's OpenAI calls. It is never stored on the server or written to logs; error messages are scrubbed of anything that looks like a key.
- "Remove my key" deletes the cookie. Best practice: create a key just for the trial, with a low spending limit, and revoke it afterward.

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

- **The reaction timer measures sampled frame to browser playback.** It excludes the wait before sampling and Bluetooth output delay. Earlier local tests reached about 3 s overall, including about 1.5 s for the selected narrator.
- **Current production latency and cost still need a device trial.** The latest cancellation, visual checks and stateless audio changes have automated regression coverage; the older local measurements above are not measurements of those changes on Vercel or AirPods.
- **Street mode is for reading and orientation,** not for safety.
- **`gpt-4o-mini-tts` is marked as deprecated** by OpenAI.

## Built with

OpenAI models only: Decisions API (`gpt-6-luna`), GPT-6.1 Sol, `gpt-4o-mini-tts`, with GPT-Live evaluated.
The project was finished with OpenAI Codex.
Stack: Next.js 16, React 19, TypeScript.

## License

MIT. See [LICENSE](LICENSE). Bring your own OpenAI API key.
