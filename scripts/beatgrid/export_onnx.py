"""
Exports a Beat This! checkpoint to ONNX for booth's tracker (analysis/beats.ts)
and checks the export against PyTorch.

    python export_onnx.py [final0|small0] ~/.booth/models/beat_this-final0.onnx

Needs torch, onnx, onnxruntime and beat_this (github.com/CPJKU/beat_this, MIT).
"""
import sys
import numpy as np
import onnxruntime as ort
import torch
from beat_this.inference import load_model

name, out = sys.argv[1], sys.argv[2]
model = load_model(name, "cpu")


class Logits(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        p = self.m(x)
        return p["beat"], p["downbeat"]


wrapped = Logits(model).eval()
torch.onnx.export(wrapped, (torch.randn(1, 1500, 128),), out, input_names=["spect"], output_names=["beat", "downbeat"],
                  dynamic_axes={"spect": {1: "t"}, "beat": {1: "t"}, "downbeat": {1: "t"}}, opset_version=17, dynamo=False)
session = ort.InferenceSession(out)
for frames in (1500, 700):
    x = torch.randn(1, frames, 128)
    with torch.no_grad():
        ref = wrapped(x)
    got = session.run(None, {"spect": x.numpy()})
    print(frames, "frames: max difference", max(float(np.abs(g - r.numpy()).max()) for g, r in zip(got, ref)))
