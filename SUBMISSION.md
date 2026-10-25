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

1. `POST /s2s/v2.0/file` registers the image and returns a `file_id` plus a presigned S3 URL.
2. `PUT` the same bytes to that presigned URL. Upload is two-step; the task fails with `error_download_image` if this step is skipped.
3. `POST /s2s/v2.0/task/skin-analysis` with `src_file_id` and eight `dst_actions` (wrinkle, pore, texture, acne, oiliness, redness, radiance, moisture) returns a `task_id`.
4. `GET /s2s/v2.0/task/skin-analysis/{task_id}` is polled until `task_status` is `success`; the response points at a results ZIP, and `score_info.json` inside it holds the per-concern `ui_score` values.

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

## Demo video (recorded, 62s)

Recorded from the running app against the live API, not from mock mode:

1. 0:00-0:06 - Title.
2. 0:06-0:42 - End-to-end run: drop a selfie, eight concern scores appear, log a routine change, see the dated history.
3. 0:42-0:54 - The four API calls, and why the key stays server-side.
4. 0:54-1:02 - What the record is for: dated deltas, noise labelled as noise.
