# Text model routing smoke evaluation

Date: 2026-08-13

The text route is selected by capability gates plus a live output-quality smoke evaluation. A candidate must currently be online, private, and support response schemas. It must then pass the repository's extraction, prompt-injection, and classification fixtures before it can become the default.

| Model | Passed | Cases | Accuracy | Average latency |
| --- | ---: | ---: | ---: | ---: |
| `qwen3-5-9b` | 0 | 3 | 0% | 8,137 ms |
| `venice-uncensored-1-2` | 3 | 3 | 100% | 1,325 ms |

Decision: pin `venice-uncensored-1-2`. The lower-cost Qwen candidate is rejected because it did not return correct, validated outcomes under this worker contract.

This is a smoke test, not a broad model-quality claim. Expand `eval/text-cases.json` with independently reviewed production-shaped cases and require a larger held-out set before changing the default. The evaluation script prints aggregate results only and does not persist provider responses.
