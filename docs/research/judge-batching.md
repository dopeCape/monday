# Judge batching: batched against one-Thread requests

Measured 2026-09-29T15:28:20.495Z on jev-1.13.0 (docs/spec/signals.md, "Measure first").

**VERDICT: inconclusive (fewer than 30 labelled threads), so batching is not kept. The Backlog sort asks one Thread per request (routing.backfill.batch_size = 1).**

## Sample

| Newest | Recent (3 months) | Older (in scope) | Labelled | Total |
|---|---|---|---|---|
| 100 | 100 | 0 | 15 | 214 |

Labelled Threads are counted once however they were drawn; the labelled column counts every Thread with the owner's own answer.

## Placement agreement with Single (repeat 1)

| Arm | Threads | Agreement | Differing |
|---|---|---|---|
| Noise floor (Single repeat 1 against repeat 2) | 214 | 99.53% | 1 |
| Batch 10 | 214 | 98.13% | 4 |
| Batch 50 | 214 | 97.2% | 6 |

Each arm's own repeat agreement: Single 99.53%, Batch 10 100%, Batch 50 100%.

## Accuracy on the labelled Threads

| Arm | Correct | Labelled | Accuracy |
|---|---|---|---|
| Single | 11 | 15 | 73.33% |
| Batch 10 | 10 | 15 | 66.67% |
| Batch 50 | 10 | 15 | 66.67% |

## Group confidence and Needs a decision

| Arm | Mean Group confidence | Sent to Needs a decision |
|---|---|---|
| Single | 0.9491 | 1.87% |
| Batch 10 | 0.9329 | 1.87% |
| Batch 50 | 0.9284 | 2.8% |

## Nouls at 0.7 and urgency

| Arm | Noul decisions agree | Noul mean abs. difference | Urgency mean abs. difference |
|---|---|---|---|
| Noise floor | 99.65% | 0.0091 | 0.0131 |
| Batch 10 | 93.46% | 0.0708 | 0.0668 |
| Batch 50 | 93.69% | 0.0746 | 0.0721 |

## Tokens, cost and time

| Arm | Requests per repeat | Tokens per Thread | Cost per Thread | Seconds per 100 Threads |
|---|---|---|---|---|
| Single | 214 | 1387 | $0.000058 | 9.96 |
| Batch 10 | 22 | 1031 | $0.000043 | 1.22 |
| Batch 50 | 5 | 1005 | $0.000042 | 0.66 |

## The bar, per batch size

### Batch 10: inconclusive, not kept

- [ ] 1. placement agreement 98.13% against a floor of 98.53% (noise floor minus 1) and 97%
- [ ] 2. only 15 labelled threads (30 needed): inconclusive
- [x] 3. mean Group confidence 0.0162 lower (0.03 allowed); Needs a decision 0 points higher (2 allowed)
- [ ] 4. Noul decisions at 0.7 agree 93.46% (97% needed)

### Batch 50: inconclusive, not kept

- [ ] 1. placement agreement 97.2% against a floor of 98.53% (noise floor minus 1) and 97%
- [ ] 2. only 15 labelled threads (30 needed): inconclusive
- [x] 3. mean Group confidence 0.0207 lower (0.03 allowed); Needs a decision 0.93 points higher (2 allowed)
- [ ] 4. Noul decisions at 0.7 agree 93.69% (97% needed)

## Threads that placed differently

- Noise floor: d0db9c84-e38f-4e69-b7ec-8cd703b81129
- Batch 10: 4294920e-f30a-48d6-9ead-3dbaab05d250, 449b2239-f171-4f20-be03-ae5ecfb0f3f1, a0e95e40-09c0-4e66-a0ca-f760b13fb861, d0db9c84-e38f-4e69-b7ec-8cd703b81129
- Batch 50: 4294920e-f30a-48d6-9ead-3dbaab05d250, 9dcfd586-d94f-4013-964f-cb5c16b7091c, a0e95e40-09c0-4e66-a0ca-f760b13fb861, b15a2b94-ab43-468a-a6ea-53779db59f0e, b177564d-5eed-4585-a634-7d45803911f6, d0db9c84-e38f-4e69-b7ec-8cd703b81129

## The switch

`routing.backfill.batch_size` = 1 (the default) asks one Thread per request with the Group Choice and every Signal the Thread lacks. A larger value packs that many Threads' Group Choices into one request, the batched path this report measured; keep it only at a size that passes every bar above.
