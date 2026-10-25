# Devpost submission draft — YouCam API Skin AI & eCommerce VTO Hackathon

## Name
Skin Ledger

## Tagline
Your skin, on the record. Dated scans, your own baseline, and a change log that tells you whether the thing you changed actually worked.

## Inspiration
Skin-analysis apps are everywhere and almost all of them do the same thing: one photo in, one score out, then everything is forgotten. That makes the only question a user actually cares about unanswerable — *is my routine working?* A score of 68 means nothing without the score from four weeks ago, taken on the same phone, in the same light.

## What it does
Skin Ledger turns the YouCam Skin AI API into a longitudinal record:

- **Dated scans.** Every analysis is stored with a timestamp and a small thumbnail.
- **Your baseline, not the population.** Each concern is compared against your own first scan, so device and lighting differences stop masquerading as progress.
- **Noise is labelled.** Moves under 3 points are shown as flat. The app refuses to invent improvement.
- **A change log.** Log "started 0.1% retinol" and "added SPF 50", and the deltas sit next to the dates, so a change is attributable instead of assumed.
- **Export.** One JSON file with every record and change, for a dermatologist or another tool.

## How we built it
A dependency-free Node server proxies the YouCam API so the key never reaches the browser:

1. `POST /v2.0/file` uploads the image and returns a `file_id`.
2. `POST /v2.0/task/skin-analysis` with `src_file_id` and eight `dst_actions` (wrinkle, pore, texture, acne, oiliness, redness, radiance, moisture) returns a `task_id`.
3. `GET /v2.0/task/skin-analysis/{task_id}` is polled until the task succeeds.

The client stores records in `localStorage` and renders the delta and history. A deterministic mock mode lets the UI run without a key, which is how the interface was built.

## Challenges
The hard part was not the API call. It was deciding what a score is allowed to mean. Comparing against a population average is easy and misleading; comparing against the user's own baseline is harder but honest. Labelling small deltas as noise cost us the satisfying "you improved 12%" moment and bought credibility instead.

## What we learned
Skin AI is fast and the eight concern scores are stable enough to compare across scans when the input conditions are consistent. The value of the product is entirely in the record around the model call.

## What's next
- Routine attribution with more than two data points, so a change can be tested rather than assumed.
- A retailer mode: a storefront embeds the same record so a customer can see whether a product moved their own numbers, not just a before/after photo.
- Optional on-device encryption of the local record.

## Built with
Node.js, vanilla JavaScript, YouCam Skin AI API (v2.0).

## Demo video script (3 minutes)
1. 0:00–0:25 — Problem: a single score tells you nothing. Show the empty app.
2. 0:25–0:55 — Upload a selfie, run the scan, eight concerns appear with a timestamp.
3. 0:55–1:30 — Show the same user four weeks later: delta against baseline, flat moves labelled flat.
4. 1:30–2:05 — Log a product change; show it landing next to the dates.
5. 2:05–2:30 — History view and export.
6. 2:30–2:55 — Under the hood: the three API calls, key kept server-side, mock mode.
7. 2:55–3:00 — Close on the one line: the product is the record, not the model call.
