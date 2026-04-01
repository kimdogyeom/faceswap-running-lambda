import hashlib
import os
import pathlib
import urllib.request

from insightface.app import FaceAnalysis

MODEL_ROOT = os.environ.get("MODEL_ROOT", "/opt/insightface")
HF_URL = (
    "https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/"
    "6ffdf0e83c5996cc425e77b59913fc48d79441be/inswapper_128.onnx"
)
HF_SHA256 = "e4a3f08c753cb72d04e10aa0f7dbe3deebbf39567d4ead6dce08e98aa49e16af"


def download_file(url: str, destination: pathlib.Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, destination)


def verify_sha256(file_path: pathlib.Path, expected_sha256: str) -> None:
    digest = hashlib.sha256()
    with file_path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual != expected_sha256:
        raise RuntimeError(f"SHA256 mismatch for {file_path}: {actual} != {expected_sha256}")


def main() -> None:
    model_root = pathlib.Path(MODEL_ROOT)
    inswapper_path = model_root / "models" / "inswapper_128.onnx"
    if not inswapper_path.exists():
        download_file(HF_URL, inswapper_path)
    verify_sha256(inswapper_path, HF_SHA256)

    # This downloads buffalo_l into MODEL_ROOT/models/buffalo_l for cold-start-free inference.
    app = FaceAnalysis(name="buffalo_l", root=str(model_root), providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))


if __name__ == "__main__":
    main()

