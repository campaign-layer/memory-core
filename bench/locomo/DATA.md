# LoCoMo dataset

**Not committed.** `locomo10.json` is third-party data released by its own authors
under their own terms. This harness reads it; it does not redistribute it.

## Source

LoCoMo (Maharana et al., 2024), [arXiv:2402.17753](https://arxiv.org/abs/2402.17753) —
GitHub [`snap-research/locomo`](https://github.com/snap-research/locomo), file
`data/locomo10.json`.

## Download

```bash
cd bench/locomo
mkdir -p data

# Option A: just the one file
curl -L -o data/locomo10.json \
  https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json

# Option B: the whole repo (also gets the paper's own eval scripts)
git clone --depth 1 https://github.com/snap-research/locomo /tmp/locomo
cp /tmp/locomo/data/locomo10.json data/
```

## Expected layout and hash

Place the file here (or point `LOCOMO_DATA` elsewhere):

```
bench/locomo/data/locomo10.json    2,805,274 bytes
```

```
sha256(locomo10.json) = 79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4
```

Verify before running:

```bash
shasum -a 256 data/locomo10.json   # macOS
sha256sum data/locomo10.json       # Linux
```

`79fa87e90f040813…` is the hash carried in `results/mode_a.json` and
`results/mode_b.json` as `provenance.dataset_sha256`. **If your copy hashes differently
you are not running the same benchmark**, and your numbers are not comparable to the
committed ones. `build_corpus.py` records the hash it actually read, so a mismatch
cannot pass silently.

The other files in the upstream repo (`msc_personas_all.json`, `multimodal_dialog/`,
the `task_eval/` scripts) are not used.

## What happens after download

`build_corpus.py` derives the canonical corpus every system indexes and writes it to
`work/corpus.json` with three hashes:

| hash | covers | recorded value for the committed run |
|---|---|---|
| `dataset_sha256` | the raw upstream file | `79fa87e90f040813…` |
| `corpus_sha256` | ids + indexed text of all 5,882 turns | `26ec6082f1589897…` |
| `query_sha256` | question text + gold turn ids | `a0f80aa287c16c6a…` |

`corpus_sha256` is the load-bearing one: `run_retrieval.ts` recomputes it and refuses
to run on a mismatch, which is what makes "same corpus for every system" a check rather
than a claim.

**What is deliberately NOT ingested:** the `observation`, `session_summary` and
`event_summary` annotation fields. They are human/model-written summaries of the
dialogue and would leak answers. Only `conversation.session_N[]` turn text, the
`blip_caption` image captions, the speaker names and `session_N_date_time` are indexed.
`audit_leakage.py` verifies this against the raw file on every run.

Both `data/` and `work/` are gitignored.
