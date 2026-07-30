# LongMemEval dataset

**Not committed.** `longmemeval_s.json` is 278 MB and is third-party data released by
its own authors under their own terms. This harness reads it; it does not
redistribute it.

## Source

LongMemEval (Wu et al., 2024), [arXiv:2410.10813](https://arxiv.org/abs/2410.10813) —
HuggingFace dataset [`xiaowu0162/longmemeval`](https://huggingface.co/datasets/xiaowu0162/longmemeval).

## Download

```bash
cd bench/longmemeval
mkdir -p data

# Option A: huggingface-cli (pip install -U "huggingface_hub[cli]")
huggingface-cli download xiaowu0162/longmemeval \
  --repo-type dataset --local-dir ./hf-download
# the release ships a tar; unpack it and move the JSON files into data/
mv ./hf-download/longmemeval_s.json      data/
mv ./hf-download/longmemeval_oracle.json data/   # optional, see below

# Option B: python
python3 - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download("xiaowu0162/longmemeval", repo_type="dataset", local_dir="hf-download")
PY
```

## Expected layout and hashes

Place the files here (or point `LME_DATASET` / `LME_DATA_DIR` elsewhere):

```
bench/longmemeval/data/longmemeval_s.json        278,025,796 bytes
bench/longmemeval/data/longmemeval_oracle.json    15,388,478 bytes   (optional)
```

```
sha256(longmemeval_s.json)      = 08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894
sha256(longmemeval_oracle.json) = 821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c
```

Verify before running:

```bash
shasum -a 256 data/longmemeval_s.json      # macOS
sha256sum data/longmemeval_s.json          # Linux
```

`08d8dad4be43ee20…` is the hash carried in every artifact under `results/`. **If your
copy hashes differently you are not running the same benchmark**, and your numbers are
not comparable to the committed ones — the harness records the hash it actually read
into `provenance.dataset.sha256` of each report so this cannot pass silently.

## Which file is used

- **`longmemeval_s.json` is required.** All 500 questions, full haystack. This is the
  only file the harness reads.
- **`longmemeval_oracle.json` is optional and currently unused.** Mode B's `oracle`
  condition does *not* read it: it builds the oracle context from the gold turns of
  `longmemeval_s` (`has_answer === true`), so the oracle upper bound is measured on the
  exact same corpus construction as the retrieval conditions. It is listed here because
  it is the natural cross-check to reach for, and because using it instead would change
  the number.

`longmemeval_m` is not used at all.

## What happens after download

`prepare.ts` (run for you by `./run-modeA.sh`) splits the 278 MB file into one file per
question under `work/split/`, and writes `work/manifest.json` with the dataset hash,
per-question statistics, and the list of zero-gold questions excluded from retrieval
scoring. Every later stage reads only the split files, so no worker ever holds the whole
dataset in memory. Both `data/` and `work/` are gitignored.
