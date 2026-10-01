"""Export a Hugging Face AI-text detector to ONNX (fp32 + fp16) in Transformers.js layout.

    python model/export.py vanguard

Writes:
  model/out/<name>/model.onnx                        fp32, kept locally for parity checks only
  public/models/<name>/{config,tokenizer*}.json      shipped with the extension
  public/models/<name>/onnx/model_fp16.onnx         fp16 (Transformers.js dtype "fp16"), shipped

Then compares PyTorch vs ONNX fp32 vs ONNX fp16 scores on sample texts.

Why fp16 and not 8-bit: on WebGPU, 8-bit weight-only (MatMulNBits) was barely faster than WASM
(1.7 s vs 2.0 s at 512 tokens), while fp16 ran 0.11 s, with WASM speed unchanged and lower error.
Dynamic int8 (quantize_dynamic) was worse still: up to 0.15 score error. See commit 34a3e60.
"""

import argparse
import shutil
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from huggingface_hub import snapshot_download
from onnxruntime.transformers.float16 import convert_float_to_float16
from transformers import AutoModelForSequenceClassification, AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent

# Keep in sync with lib/models.ts.
MODELS = {
    "vanguard": {"repo": "ShantanuT01/vanguard-ai-text-detector", "head": "sigmoid"},
    "tabularis": {"repo": "tabularisai/ai-text-detection", "head": "softmax"},
}
MAX_TOKENS = 512
SHIPPED_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]

SAMPLES = [
    # Human-written (Wikipedia-style and casual).
    "The bridge was closed for three weeks in 1987 after a barge struck one of its piers during a storm.",
    "honestly i didn't expect the ending at all, my sister cried and i just sat there like ok what",
    # AI-flavored.
    "In today's fast-paced world, effective communication is more important than ever. By leveraging "
    "cutting-edge tools and fostering a culture of collaboration, organizations can unlock new levels of productivity.",
    "Certainly! Here is a concise overview of the key benefits of renewable energy: it reduces greenhouse gas "
    "emissions, enhances energy security, and creates sustainable economic opportunities.",
    "My grandmother kept chickens until she was 91. She named every one of them after a different Supreme Court "
    "justice, which got confusing when two of them were both called Ruth.",
    "We missed the 8:15 train so we walked to the next station, got rained on, and ended up eating cold pizza at "
    "the platform. Best day of the trip, weirdly.",
    "Machine learning models have transformed numerous industries by enabling data-driven decision-making. However, "
    "it is crucial to consider ethical implications, such as bias and transparency, to ensure responsible deployment.",
    "Overall, this approach offers a robust and scalable solution that balances performance, maintainability, and "
    "user experience, making it an excellent choice for modern applications.",
]


def to_score(logits: np.ndarray, head: str) -> np.ndarray:
    if head == "sigmoid":
        return 1 / (1 + np.exp(-logits[:, 0]))
    e = np.exp(logits - logits.max(axis=1, keepdims=True))
    return (e / e.sum(axis=1, keepdims=True))[:, 1]


def export(name: str) -> None:
    spec = MODELS[name]
    src = Path(snapshot_download(spec["repo"], allow_patterns=["*.json", "*.safetensors"]))
    work = ROOT / "model" / "out" / name
    ship = ROOT / "public" / "models" / name
    (ship / "onnx").mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(src)
    model = AutoModelForSequenceClassification.from_pretrained(src, attn_implementation="eager").eval()
    model.config.reference_compile = False  # no torch.compile inside forward during export

    # 1. fp32 export (reused if present; delete model/out/<name> to force)
    fp32 = work / "model.onnx"
    if not fp32.exists():
        dummy = tokenizer(SAMPLES[:2], padding=True, return_tensors="pt")
        batch, seq = torch.export.Dim("batch"), torch.export.Dim("sequence", max=MAX_TOKENS)
        torch.onnx.export(
            model,
            (),
            fp32,
            kwargs={"input_ids": dummy["input_ids"], "attention_mask": dummy["attention_mask"]},
            input_names=["input_ids", "attention_mask"],
            output_names=["logits"],
            dynamic_shapes={"input_ids": {0: batch, 1: seq}, "attention_mask": {0: batch, 1: seq}},
            dynamo=True,
            external_data=False,
        )
        # The exporter leaves stale intermediate shape annotations that fail onnx shape inference
        # ("Inferred shape and existing shape differ"). They are optional hints.
        m = onnx.load(fp32)
        del m.graph.value_info[:]
        onnx.save(m, fp32)

    # 2. fp16 weights and activations; inputs/outputs stay int64/fp32
    fp16 = ship / "onnx" / "model_fp16.onnx"
    onnx.save(convert_float_to_float16(onnx.load(fp32), keep_io_types=True), fp16)

    for f in SHIPPED_FILES:
        if (src / f).exists():
            shutil.copy(src / f, ship / f)

    # 3. parity check
    enc = tokenizer(SAMPLES, padding=True, truncation=True, max_length=MAX_TOKENS, return_tensors="np")
    feeds = {"input_ids": enc["input_ids"].astype(np.int64), "attention_mask": enc["attention_mask"].astype(np.int64)}
    with torch.no_grad():
        ref = to_score(model(**{k: torch.from_numpy(v) for k, v in feeds.items()}).logits.numpy(), spec["head"])

    print(f"\n{'sample':<50} {'torch':>7} {'fp32':>7} {'fp16':>7}")
    scores = {}
    for label, path in [("fp32", fp32), ("fp16", fp16)]:
        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        scores[label] = to_score(sess.run(["logits"], feeds)[0], spec["head"])
    for i, text in enumerate(SAMPLES):
        print(f"{text[:48]:<50} {ref[i]:7.4f} {scores['fp32'][i]:7.4f} {scores['fp16'][i]:7.4f}")
    for label in scores:
        print(f"max |torch - {label}| = {np.abs(ref - scores[label]).max():.4f}")
    print(f"\nShipped: {ship}  ({sum(p.stat().st_size for p in ship.rglob('*') if p.is_file()) / 1e6:.0f} MB)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("name", choices=MODELS)
    export(parser.parse_args().name)
