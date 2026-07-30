# LongMemEval Mode B (QA + LLM judge) - memory-core internal harness

Answerer & judge: deepseek/deepseek-v4-flash (temperature 0). Retrieval: memory-core.
Repo 5ea3852, dataset sha256 08d8dad4be43ee20...

## Accuracy, ANSWERABLE questions (strict judge)

| condition | n | correct | accuracy | said IDK | errors |
|---|---|---|---|---|---|
| k10 | 479 | 300 | 0.6263 | 121 | 0 |
| k30 | 479 | 333 | 0.6952 | 88 | 0 |
| oracle | 150 | 123 | 0.8200 | 15 | 0 |

## Accuracy by question_type (answerable only)

| question_type | k10 | k30 | oracle |
|---|---|---|---|
| temporal-reasoning | 0.545 (72/132) | 0.621 (82/132) | 0.756 (31/41) |
| multi-session | 0.400 (50/125) | 0.496 (62/125) | 0.718 (28/39) |
| knowledge-update | 0.764 (55/72) | 0.778 (56/72) | 0.783 (18/23) |
| single-session-user | 0.859 (55/64) | 0.922 (59/64) | 0.950 (19/20) |
| single-session-assistant | 0.929 (52/56) | 0.964 (54/56) | 1.000 (18/18) |
| single-session-preference | 0.533 (16/30) | 0.667 (20/30) | 1.000 (9/9) |

## Abstention subset (LongMemEval *_abs questions, gold = "information was never provided")

Scored with the opposite rubric: declining is CORRECT, fabricating an answer is INCORRECT.
Reported separately and never folded into the headline accuracy.

| condition | n | correctly declined | accuracy |
|---|---|---|---|
| k10 | 21 | 20 | 0.9524 |
| k30 | 21 | 19 | 0.9048 |

## Cost

prompt tokens 6,152,965, completion tokens 294,009, cost $0.8551

## Honesty note

OUR harness, OUR reader model, on the public LongMemEval_S dataset. Not comparable to
published LongMemEval numbers: different retrieval granularity, different reader, different
judge, different prompt. The oracle row is the answering ceiling for this reader+judge;
oracle-minus-k30 is retrieval failure, and 100%-minus-oracle is reader/judge failure.
