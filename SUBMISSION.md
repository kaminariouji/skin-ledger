# Devpost submission — YouCam API Skin AI & eCommerce VTO Hackathon

## Name
Skin Ledger

## Tagline
Your skin, on the record. Dated scans, your own baseline, and a change log that tells you whether the thing you changed actually worked.

## Inspiration
Skin-analysis apps are everywhere and almost all of them do the same thing: one photo in, one score out, then everything is forgotten. That makes the only question a user actually cares about unanswerable — *is my routine working?* A score of 68 means nothing without the score from four weeks ago, taken on the same phone, in the same light, framed the same way.

## What it does
Skin Ledger turns the YouCam Skin AI API into a longitudinal record:

- **Dated scans with a real baseline.** Every analysis is stored with a timestamp. Each concern is compared against a scan you choose, not against a population average, so device and lighting differences stop masquerading as progress.
- **Noise is labelled.** Moves under 3 points are shown as flat. The app refuses to invent improvement.
- **Heatmap from the model's own masks.** The Skin AI task returns one mask PNG per concern inside the results ZIP. The app renders those masks over the analysed image, so you can see *where* the model sees redness or acne rather than only a number. Nothing is drawn by the app.
- **Two depths, one ledger.** Standard runs the eight SD concerns. HD runs fifteen scored v2.1 concerns plus a skin-type reading, and returns 24 regional readings - wrinkle split across forehead, glabellar, crowfeet, periocular, nasolabial, marionette and whole, pore across forehead, nose and cheek - plus an overall score, a skin age and a skin type. The report table sorts concerns worst-first and prints the regional spread beside each whole-face score, so a good average with one bad region is visible instead of hidden.
- **Baseline / today split slider.** A draggable divider compares the first scan and the latest side by side, which is the comparison people actually make by eye — except here it is aligned.
- **Batch scan queue.** Drop several photos at once; they are scanned one by one with per-item status. Rejected frames fail individually and report why.
- **Live camera with guardrails.** Capture in-app with a translucent ghost of your last baseline over the viewfinder - opacity on a 0-60% slider, a Ghost toggle, and the baseline date printed on the control bar, so you line your face up against the exact same frame you will be compared with - plus live checks for exposure, focus and whether a face is filling the oval. The shutter stays disabled until light and framing pass.
- **Label scan.** Photograph a product label and the app writes down the whole composition, not just the actives: the printed list is parsed locally in about two seconds, then a model titles the product and repairs OCR damage in ingredient names ("Methoxycinnamse" becomes Octyl Methoxycinnamate). One press logs the product with its composition attached, so a later change can be read against what was actually in the bottle.
- **A copilot that reads only your numbers.** Ask "why is redness still flat?" and it answers from your dated scores and change log — never the photo, never a diagnosis.
- **Daily factors.** Log sleep and water next to your scans and see them on the same time axis. A pattern is not a cause, and the app says so.

## Who it is for

**Consumer.** Someone eight weeks into a routine who cannot tell whether the new serum is working. Today they compare two selfies by eye, from different angles, in different light. Skin Ledger gives them a dated record, one baseline, and a rule they can trust: a move under 3 points is noise, so the app will not tell them a story the data does not support.

**Retail and brands.** A skincare line embeds the same ledger in its own storefront: customers scan before and after a product, and the brand gets dated per-concern deltas instead of a before/after photo and a claim. That is a defensible B2B product because the value is the record, not the model call.

**Unit economics.** A standard scan costs 12 YouCam units (five to eight concerns) and HD costs 22 (thirteen to sixteen). A twelve-week routine test with a scan every two weeks is seven scans per user: 84 units standard, 154 HD, plus a re-scan budget of about 30% for frames the model rejects. The record is stored on the user's device, so serving cost after the scan is zero.

## How we built it
A dependency-free Node server proxies the YouCam API so the key never reaches the browser:

1. `POST /s2s/v2.0/file` registers the image and returns a `file_id` plus a presigned S3 URL.
2. `PUT` the same bytes to that URL. Upload is two-step; the task fails with `error_download_image` if this is skipped.
3. `POST /s2s/v2.0/task/skin-analysis` with `src_file_id` and eight `dst_actions` returns a `task_id`.
4. `GET /s2s/v2.0/task/skin-analysis/{task_id}` is polled until `task_status` is `success`. The result is a ZIP holding `score_info.json` and one mask PNG per concern; the server unzips it, serves the masks as assets, and returns normalised scores.

5. HD is a different task path: `POST /s2s/v2.1/task/skin-analysis` with sixteen `hd_*` actions and `format: "json"` in the body. Without that field the service answers in the zip shape and the per-region array is simply absent - which reads as a successful task with no output. HD needs at least 1080 px on the short side, so the client renders its crop at 2048 when HD is selected and the server returns `image_too_small_hd` with the measured size when it is smaller.

The client stores records in `localStorage`, renders deltas, sparklines and the split slider, and recolours each mask into a heatmap ramp on a canvas. A deterministic mock mode lets the interface run without a key.

Two failure modes shaped the UI. The model rejects frames where the face fills less than 60% of the width, so the app has a zoom/pan framing stage that tells you exactly how to reframe instead of silently re-billing another scan. And the analysis worker occasionally cannot fetch the object we just uploaded, so the server retries that specific error once.

## Challenges
The hard part was not the API call. It was deciding what a score is allowed to mean. Comparing against a population average is easy and misleading; comparing against the user's own baseline is harder but honest. Labelling small deltas as noise cost us the satisfying "you improved 12%" moment and bought credibility instead.

The second challenge was framing. A longitudinal product is only as good as the repeatability of its input, which is why zoom, the ghost overlay and the exposure checks exist at all.

## What we learned
Skin AI is fast - 10.6 seconds end to end on a 1200 px frame, measured on 26 October including upload, polling and the mask download — and the eight concern scores are stable enough to compare across scans when the input conditions are consistent. The masks are the most under-used part of the API: they turn a number into a location. HD costs 22 units per image against 12 for the eight SD concerns and needs a 2048 px frame; those two numbers decide when HD is worth asking for.

## What's next
- **White-label for brands.** A skincare line embeds the same ledger: customers scan before and after a product, and the brand gets dated, per-concern deltas instead of a before/after photo and a claim. That is a defensible B2B product because the value is the record, not the model call.
- Routine attribution with more than two data points, so a change can be tested rather than assumed.
- Optional on-device encryption of the local record.

## Built with
Node.js (no dependencies), vanilla JavaScript, Canvas, YouCam Skin AI API v2.0 (Standard) and v2.1 (HD), OCR.space for label text, a hosted language model for the copilot.

## Judge it in 60 seconds

1. Open the app and press **Load a sample record** in the capture panel. It loads four dated scans, five routine changes and four daily logs without spending an API unit.
2. The page jumps to the baseline/today slider, then scroll down: per-concern deltas against your own baseline, the change log with each product's composition, and the attribution card that reads "since you started azelaic acid, acne moved +23".
3. Ask the copilot "why did acne improve?" - it answers from those numbers only.
4. Press **Scan label** to see the label path, or run a live scan with your own key.

## Demo video (recorded, 89s)
Recorded from the running app against the live API, not from mock mode:

1. 0:00-0:06 — Title.
2. 0:06-0:59 — End to end: queue two photos, scan them, eight scores with sparklines, heatmap masks, the baseline/today split slider, and the copilot answering from the ledger.
3. 0:59-1:10 — The four API calls and where the masks come from.
4. 1:10-1:19 — The six features in one frame.
5. 1:19-1:29 — Why a brand would pay for it.
