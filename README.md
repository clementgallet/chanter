# Chanter

A self-hosted web app (installable on iOS and Android as a PWA) for **Great Highland bagpipe** tunes:

- **Import** scores in ABC format from files, a web address or pasted text. Everything imported is stored and kept for later (on the server, or on the device when hosted on GitHub Pages).
- **Browse** the library by category and search by tune name.
- **View and play** a tune: the score is engraved from the ABC, played back with a pipe-chanter-like synth (optional drones, speed control), with a highlight that follows the notes. Tap a note or drag the progress bar to jump.
- **Detect a tune** from live microphone playing or an imported audio file (WAV and anything else the browser can decode). The tune is matched against the library and ranked by likelihood.

There are no runtime dependencies: a plain Node.js server (Node 18+) and static files. abcjs is vendored in `public/vendor`.

Two ways to run it: **[on GitHub Pages](#host-it-on-github-pages-easiest-on-a-phone)** (nothing to host, works on a phone from anywhere, HTTPS included) or **[self-hosted](#run-it-on-your-own-computer)** with the Node server.

## Your own tunes: the `tunes/` folder

Put your `.abc` files (any number of tunes per file, subfolders allowed) in `tunes/`. They become part of the library for everyone using the app, so phones never need to import them by hand:

- on GitHub Pages, they are baked into the site at build time;
- with `npm start`, they are imported on every start. A tune you delete in the app stays deleted (remembered in `data/seeded.json`).

`tunes/demo-tunes.abc` holds 12 original demo tunes; delete it when you have your own. Note that the demo tunes deliberately share a few phrases, so playing a part of one can also score the others noticeably.

## Host it on GitHub Pages (easiest on a phone)

The app also runs as a purely static site: no server, the tunes in `tunes/` are built into the site, and anything a user imports on their phone is stored in that browser (IndexedDB), private to that device.

1. Create a GitHub repository and push this project to the `main` branch (`data/`, `dist/` and `node_modules/` are git-ignored).
2. In the repository, open **Settings > Pages** and set **Source** to **GitHub Actions**.
3. The workflow `.github/workflows/pages.yml` builds and deploys on every push to `main` (or run it by hand from the Actions tab). Your app is then at `https://<user>.github.io/<repo>/`.
4. Open that address on the phone and use Share / menu > **Add to Home Screen**. Pages is served over HTTPS, so the microphone and installation work without any certificate setup.

Adding tunes later: drop more `.abc` files in `tunes/`, commit and push; the site updates itself. Phones get them next time they open the app online.

Differences from the server mode: imports from the phone stay on that phone (they are not shared), importing by web address works only for sites that allow cross-origin downloads (GitHub links do), and removing a bundled tune only hides it on that device. If the repository is private, GitHub Pages needs a paid plan; a public repository is free.

Test it locally: `npm run build` creates `dist/`, then `npm run serve:dist` serves it at `http://localhost:8090/chanter/` like Pages would.

## Run it on your own computer

```sh
npm start
```

The server prints the addresses to use:

- `http://localhost:8080` on the computer running it.
- `https://<computer-ip>:8443` on your phone (same Wi-Fi).

Every `.abc` file in `tunes/` is imported on start (see above).

Environment variables: `PORT` (8080), `HTTPS_PORT` (8443), `HOST` (0.0.0.0), `NO_HTTPS=1`, and the data directory is `data/` (`data/tunes/*.abc`, `data/library.json`, `data/imports/` for the untouched originals, `data/certs/`).

### Why HTTPS matters on a phone

Browsers only allow microphone access and PWA installation on secure origins (`https://` or `localhost`). Over plain `http://<ip>:8080` the library, scores and playback all work, but the microphone and "Add to Home Screen" install do not. Audio-file detection works either way.

**Quick way (self-signed).** On first start the server creates a self-signed certificate with `openssl` (valid for the computer name and its LAN addresses). Open the `https://` address on the phone and accept the warning once. Microphone works; some phones refuse to install the PWA or register the service worker on an untrusted certificate.

**Trusted way (mkcert).** Install [mkcert](https://github.com/FiloSottile/mkcert), then:

```sh
npm run cert:mkcert     # creates data/certs/{key,cert,rootCA}.pem, then restart the server
```

Then install the root CA on the phone by opening `http://<computer-ip>:8080/ca.pem`:

- **iOS:** open the link in Safari, allow the profile download, install it in Settings > General > VPN & Device Management, then enable it in Settings > General > About > Certificate Trust Settings.
- **Android:** download the file and install it under Settings > Security > Encryption & credentials > Install a certificate > CA certificate. (Chrome on Android honours user-installed CAs; Firefox needs its own setting.)

Finally open `https://<computer-ip>:8443` and use Share / menu > **Add to Home Screen**.

If the LAN address of the computer changes, delete `data/certs/key.pem` and `cert.pem` (or rerun `npm run cert:mkcert`) and restart.

## Importing ABC

- Files may contain many tunes (`X:` blocks); each is split out and stored as its own file.
- Duplicates (identical tune text after normalisation) are detected and skipped.
- Remote import is done by the server (so it needs to reach the address). Private/loopback addresses are refused (set `ALLOW_PRIVATE_URLS=1` to import from your own LAN), redirects are limited to 5, and downloads are capped at 8 MB and 15 s. GitHub `blob` links are converted to raw links.
- The category comes from `R:` (rhythm) or `M:` (meter), e.g. "2/4 March", "6/8 March", "Hornpipe", "Jig", "Reel", "Strathspey". You can change it from the tune page.
- Bagpipe key `K:HP` (and `K:Hp`) is understood; notes outside the nine chanter notes are flagged as parsing notes.

## How tune detection works

The chanter has only nine notes (low G, low A, B, C, D, E, F, high G, high A), and that is what the detector exploits.

1. **Audio to notes.** Audio is resampled to 16 kHz and analysed as short spectra. The always-on drone is estimated per frequency bin and subtracted. Each of the nine notes is modelled as a harmonic comb, and the spectrum is decomposed over those nine atoms with non-negative least squares. The chanter tuning (low A somewhere in 425-505 Hz) is searched per recording, so no calibration is needed. A Viterbi pass chooses the best note-or-silence sequence, then short fragments are cleaned up and each note's centre is refined, tolerating real chanters being out of tune with the ideal scale.
2. **Notes to tune.** Every library tune is reduced to its sequence of chanter notes (grace notes and rests dropped, ties merged). The heard sequence is aligned with each tune by Smith-Waterman local alignment, scored with a substitution model in which a neighbouring note is a more likely error than a distant one. That makes it robust to wrong, missing or extra notes, and to starting anywhere in the tune or playing only a part of it.
3. **Confidence.** Alignment scores are converted to E-values (the expected number of equally good matches by chance anywhere in the library), calibrated per library with random null sequences, and turned into probabilities that include a "not in the library" option. The app says **Match found**, **Probable match** or **No confident match**; it will not force a name onto a tune that is not in the library.

Live mode re-analyses the last ~24 s every few seconds, so the result firms up as you keep playing; stopping runs a final analysis on the whole recording (up to 2 minutes of microphone audio, 4 minutes of file).

For best results: play close to the chanter, a few phrases (10 s or more helps), and expect the library to contain the tune as notated (a different setting of the same tune matches less strongly).

### Honest status of the testing

**The detector has only been tested on synthetic audio**, since no real bagpipe recordings were available during development. The synthetic tests (`npm test`, `npm run test:full`) render the demo tunes with randomised harmonic timbre, per-note tuning deviations, drones, noise down to 5 dB SNR, reverb, tempo jitter and clips as short as 5 s, hidden in a library padded with hundreds of random tunes. Results: 180/180 correct top-1 on all scenarios, 0 false positives among 24 non-library queries. That shows the algorithm is sound, but not how it will behave on real instruments, rooms and phone microphones. Expect to tune thresholds (`public/js/detector.js` `DEFAULTS`, verdict cut-offs in `public/js/detect-ui.js`) after trying real recordings.

Browser checks were done in Chromium, in both server and static (GitHub Pages sub-path) mode: library, score, import (paste, duplicates, persistence across reloads), delete/hide, and the full detect flow with a WAV file (worker, decoding, results); playback highlight and click-to-seek were checked in server mode. The live microphone path, playback in the static build, and iOS/Android devices themselves were not tested.

## Layout

```
server.js            HTTP/HTTPS server, JSON API, static files
lib/abc.js           ABC parser: play-order timeline + detection signature (shared by server and browser)
lib/library.js       storage; lib/remote.js SSRF-safe downloads; lib/seed.js imports tunes/ on start
tunes/               your .abc files (library content shipped with the project)
public/              the PWA (index.html, js/app.js, store.js, player.js, detect-ui.js, detect-worker.js, detector.js, sw.js)
public/js/store.js   library access: server API, or static data + IndexedDB on GitHub Pages
.github/workflows/   pages.yml: build and deploy to GitHub Pages
test/                synthetic-audio generator and detection benchmarks
scripts/             build-static.js, serve-dist.js, icon generator, mkcert helper
```

API: `GET /api/library`, `GET /api/tunes/:id`, `GET /api/tunes/:id.abc`, `PATCH|DELETE /api/tunes/:id`, `POST /api/import/{files,text,url}`, `GET /api/detect-index`.

The server has no authentication: run it on a trusted network only.
