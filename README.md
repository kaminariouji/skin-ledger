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
| Nothing to act on | Deltas under 3 points are marked flat, so the app never invents progress |

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

### Two depths

| | Standard | HD |
| --- | --- | --- |
| Task path | `/s2s/v2.0/task/skin-analysis` | `/s2s/v2.1/task/skin-analysis` |
| Readings | 8 concerns | 15 scored concerns plus a skin-type reading |
| Regions | whole face only | 24 regional readings (forehead, glabella, crowfeet, periocular, nasolabial, marionette, nose, cheek) |
| Extras | - | overall score, skin age, skin type |
| Minimum frame | 480 px on the short side | 1080 px on the short side |
| Units per image | 12 | 22 |

HD needs `format: "json"` in the task body. Without it the service answers in the ZIP shape and the regional array is simply missing, which reads as a successful task with no output.

The API key never reaches the browser — it stays in the server process and is sent as `Authorization: Bearer`.

## Run it

```bash
# mock mode: deterministic scores, no key required, useful for UI work
npm run mock

# live mode: put YOUCAM_API_KEY in .env, or set it in your shell
npm start
```

Then open <http://127.0.0.1:4173>.

No key yet? Open the app and press **Load a sample record**: four dated scans, five routine changes and four daily logs, so the comparison, the attribution and the factor chart are all visible without spending an API unit.

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `YOUCAM_API_KEY` | none | Live Skin AI calls. Without it the server starts in mock mode and the header says `API mock`. |
| `OCR_SPACE_KEY` | `helloworld` | Label reading. The default is OCR.space's public demo key (1 MB per photo). |
| `PORT` | `4173` | HTTP port. |
| `LAN` | off | `LAN=1` binds `0.0.0.0` so a phone on the same Wi-Fi can use its camera. The camera API needs a secure origin, so put a TLS proxy in front. |
| `YOUCAM_BASE` | `https://yce-api-01.makeupar.com` | Upstream host. |

Mock mode is a real mode, not a fallback that pretends to be live: it returns deterministic scores so the interface can be reviewed without a key, and every record it produces is tagged `mock`.

No dependencies. Node 20+.

## Data and privacy

- Scans and the change log live in the browser's `localStorage` only.
- A 96×96 JPEG thumbnail is kept for the history strip, plus one 512×512 JPEG for the before/after slider. The full-resolution photo is not stored.
- The selfie goes to the YouCam Skin AI API and nowhere else.
- A product-label photo is different: it is sent to OCR.space to be read as text. Set `OCR_SPACE_KEY` to use your own key; the default is the public demo key.
- The chat panel sends the dated scores and your change log to a language model so it can draft an answer. No image is ever sent there.
- `Export record` produces a JSON file you can hand to a dermatologist or import elsewhere.

## Limitations

- Not a medical device. It does not diagnose, treat, or predict anything.
- Scores are only comparable across scans from the same device and similar lighting. The app compares against your own baseline for exactly that reason.
- A single delta is not evidence. Two scans two weeks apart with one product change is a hypothesis, not a result.

## License

MIT
