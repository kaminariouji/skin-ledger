# Skin Ledger

A dated, comparable record of your skin, built on the [YouCam Skin AI API](https://docs.perfectcorp.com/reference/ai_skin_analysis).

Most skin-analysis apps give you a score, a nice gradient, and forget everything the moment you close the tab. That makes the only interesting question impossible to answer: **did the thing I changed actually help?**

Skin Ledger keeps every scan as a dated record, compares each one against your own baseline, and lets you log product changes so a delta can be attributed to something real.

## Why this is not an API wrapper

| Wrapper | Skin Ledger |
| --- | --- |
| One photo in, one score out | Every scan is persisted with a timestamp and a thumbnail |
| Scores shown in isolation | Every score is compared against *your* baseline, not a population average |
| No memory | A change log (started retinol, added SPF) is stored alongside the scans |
| Nothing to act on | Deltas under 3 points are explicitly labelled noise, so the app never invents progress |

The product is the record, not the model call.

## How it works

```
browser ──POST /api/analyze──▶ local server ──▶ YouCam API
   │                              │
   │                              ├─ POST /s2s/v2.0/file              (returns file_id + presigned S3 PUT)
   │                              ├─ PUT  <presigned S3 URL>           (binary upload, same bytes)
   │                              ├─ POST /s2s/v2.0/task/skin-analysis (src_file_id + dst_actions)
   │                              └─ GET  /s2s/v2.0/task/skin-analysis/{task_id}  (poll until success,
   │                                   then download the results ZIP and read score_info.json)
   │
   └─ stores { timestamp, scores, thumbnail } in localStorage
```

Concerns requested per scan: `wrinkle`, `pore`, `texture`, `acne`, `oiliness`, `redness`, `radiance`, `moisture`.

The API key never reaches the browser — it stays in the server process and is sent as `Authorization: Bearer`.

## Run it

```bash
# mock mode: deterministic scores, no key required, useful for UI work
npm run mock

# live mode
YOUCAM_API_KEY=your_key npm start
```

Then open <http://127.0.0.1:4173>.

No dependencies. Node 20+.

## Data and privacy

- Scans and the change log live in the browser's `localStorage` only.
- A 128×128 JPEG thumbnail is stored; the full-resolution image is not.
- Nothing is uploaded anywhere except to the YouCam API for the analysis itself.
- `Export record` produces a JSON file you can hand to a dermatologist or import elsewhere.

## Limitations

- Not a medical device. It does not diagnose, treat, or predict anything.
- Scores are only comparable across scans from the same device and similar lighting. The app compares against your own baseline for exactly that reason.
- A single delta is not evidence. Two scans two weeks apart with one product change is a hypothesis, not a result.

## License

MIT
