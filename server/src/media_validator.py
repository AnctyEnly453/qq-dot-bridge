"""Decode inline image bytes only; stdout never contains image data."""
import io
import json
import sys
import warnings

MAX_BYTES = 2 * 1024 * 1024
MAX_DIMENSION = 4096
MAX_PIXELS = 12_000_000
MAX_FRAMES = 60
FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WEBP"}


def validate(data, mime):
    from PIL import Image, ImageFile
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    if mime not in FORMATS or not isinstance(data, bytes) or not data:
        return {"ok": False, "error": "invalid_image"}
    if len(data) > MAX_BYTES:
        return {"ok": False, "error": "message_too_large"}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            with Image.open(io.BytesIO(data)) as image:
                if image.format != FORMATS[mime]:
                    return {"ok": False, "error": "invalid_image"}
                width, height = image.size
                if width < 1 or height < 1 or max(width, height) > MAX_DIMENSION or width * height > MAX_PIXELS:
                    return {"ok": False, "error": "message_too_large"}
                frames = getattr(image, "n_frames", 1)
                if frames < 1 or frames > MAX_FRAMES:
                    return {"ok": False, "error": "message_too_large"}
                image.verify()
            # verify() alone does not decode compressed pixel streams.
            with Image.open(io.BytesIO(data)) as image:
                for frame in range(frames):
                    image.seek(frame)
                    w, h = image.size
                    if w < 1 or h < 1 or max(w, h) > MAX_DIMENSION or w * h > MAX_PIXELS:
                        return {"ok": False, "error": "message_too_large"}
                    image.load()
        return {"ok": True, "format": FORMATS[mime], "width": width, "height": height, "frames": frames}
    except Exception:
        return {"ok": False, "error": "invalid_image"}


def self_test():
    from PIL import Image
    for mime, fmt in FORMATS.items():
        out = io.BytesIO()
        Image.new("RGB", (1, 1), "red").save(out, format=fmt)
        data = out.getvalue()
        assert validate(data, mime)["ok"]
        wrong = "image/jpeg" if mime != "image/jpeg" else "image/png"
        assert not validate(data, wrong)["ok"]
        assert not validate(data[:len(data)//2], mime)["ok"]
    assert not validate(b"file:///etc/passwd", "image/png")["ok"]
    assert not validate(b"x" * (MAX_BYTES + 1), "image/png")["ok"]
    for size in [(4097, 1), (4096, 4096)]:
        out = io.BytesIO()
        Image.new("1", size).save(out, "PNG")
        assert not validate(out.getvalue(), "image/png")["ok"]
    frames = [Image.new("RGB", (1, 1), (n, 0, 0)) for n in range(61)]
    out = io.BytesIO()
    frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], optimize=False)
    assert not validate(out.getvalue(), "image/gif")["ok"]
    return {"ok": True, "tests": "four_formats,mime_mismatch,truncation,path,size,pixels,frames"}


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--self-test"]:
            result = self_test()
        elif len(sys.argv) == 2 and sys.argv[1] in FORMATS:
            result = validate(sys.stdin.buffer.read(MAX_BYTES + 1), sys.argv[1])
        else:
            result = {"ok": False, "error": "invalid_image"}
    except Exception:
        result = {"ok": False, "error": "media_unavailable"}
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
