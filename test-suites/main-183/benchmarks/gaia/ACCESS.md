# GAIA-56 task content and attachments

The public case list is `cases.txt` (56 IDs). The actual task text, gold answers
and the 11 attachments are **not** committed to this public repository.

They are stored in a private, access-controlled Hugging Face dataset:

**https://huggingface.co/datasets/Migraine/Perseus-GAIA-56**

| Item | Count |
|---|---:|
| Cases | 56 |
| L1 / L2 / L3 | 10 / 20 / 26 |
| Attachments | 11 |
| Attachment bytes | 2,146,661 |

## Contents

```
manifest.json                 suite metadata, source hashes, attachment hashes
cases/<case_id>.json          task_id, level, question, attachment metadata
gold/<case_id>.json           final answer (kept out of the task prompt)
attachments/<file_name>       11 original GAIA attachment files
```

The repository is private. Request access from the owner before use. The
bundle's `manifest.json` SHA-256 is:

```
dafbb64d3a59c015ccece65049f86e1b26bcf8fcc63a02a5e368119be91f9d0a
```

`attachments.sha256` in this directory lists the 11 attachment hashes without
publishing the files. Use it to verify a downloaded bundle.

## Why this is private

GAIA is a gated benchmark. Its dataset card asks users not to reshare the
validation or test set in a crawlable format, and the gating agreement permits
redistribution only in a gated or private repository on the Hugging Face Hub.
The public Perseus repository therefore keeps only the 56 case IDs and
attachment checksums. Do not mirror the private bundle to a public GitHub
repository, public bucket, or any crawlable location.

## Loading

```python
import json
from pathlib import Path

root = Path("Perseus-GAIA-56")
case_id = "9318445f-fe6a-4e1b-acbf-c68228c9906a"
case = json.loads((root / "cases" / f"{case_id}.json").read_text())
gold = json.loads((root / "gold" / f"{case_id}.json").read_text())

prompt = case["question"]
if case["attachment"]:
    prompt += f"\n\nAttached file: {case['attachment']['file_name']}"

# Do not put gold["final_answer"] into the Actor or Speculator prompt.
```

The 56 IDs in the private bundle are exactly the IDs in `cases.txt`. The
`gold/` files are for the official exact-match scorer only.
