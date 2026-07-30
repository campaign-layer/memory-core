import glob
import json
import os

from paths import RANKINGS, WORK

files = (sorted(glob.glob(os.path.join(RANKINGS, "memory-core*.meta.json")))
         + sorted(glob.glob(os.path.join(WORK, "verification", "*.meta.json"))))
if not files:
    raise SystemExit(f"no ranking metadata under {RANKINGS}. Run run_retrieval.ts first.")
for f in files:
    d = json.load(open(f))
    print(d["system"])
    print(f"   sha={d.get('git_sha_short', 'n/a')} embedder={d.get('embedder')} "
          f"model={d.get('embedder_model')} rrfK={d.get('rrf_k')} explicit={d.get('rrf_k_explicit')}")
    print(f"   ingest={d['ingest_ms'] / 1000:.2f}s ({d.get('ingest_records_per_sec')} rec/s) "
          f"search_total={d['search_ms'] / 1000:.2f}s mean_search={d.get('mean_search_ms')}ms")
    vp = d.get("vector_path_live")
    if vp:
        print(f"   vector_path_live: vectors={vp['stored_document_vectors']} "
              f"credit={vp['hits_with_vector_credit']}/{vp['hits_total']} "
              f"({vp['hits_with_vector_credit_pct']}%) vector_only={vp['vector_only_hits']}")
    print()
