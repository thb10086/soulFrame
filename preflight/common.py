"""预检公共工具：环境加载、计时、SSE 解析、音频处理。"""
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "preflight" / "output"
OUTPUT.mkdir(parents=True, exist_ok=True)

PERSONA_PROMPT = (
    "你是「灵犀」，一个温柔、活泼的二次元虚拟角色。"
    "说话简短自然，像朋友聊天，偶尔用一点可爱的语气词，单次回复不超过60字。"
)


def load_env():
    """从项目根目录 .env 读取网关地址与密钥（不打印密钥）。"""
    env = {}
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    base = env.get("AGENTLLM_BASE_URL") or os.environ.get(
        "AGENTLLM_BASE_URL", "https://agentllm.linkyun.co"
    )
    key = env.get("AGENTLLM_API_KEY") or os.environ.get("AGENTLLM_API_KEY", "")
    if not key:
        print("错误：缺少 AGENTLLM_API_KEY，请在项目根目录 .env 中配置", file=sys.stderr)
        sys.exit(1)
    return base.rstrip("/"), key


def now():
    return time.perf_counter()


def ms(t0, t1=None):
    return round(((t1 if t1 is not None else now()) - t0) * 1000)


def iter_sse(resp):
    """迭代 httpx 流式响应中的 SSE data 行（已去掉 'data:' 前缀）。"""
    for line in resp.iter_lines():
        if not line:
            continue
        if line.startswith("data:"):
            data = line[5:].strip()
            if data and data != "[DONE]":
                yield data


def pcm_resample(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    """16-bit 单声道 PCM 重采样（线性插值，无第三方依赖）。"""
    import array

    src = array.array("h")
    src.frombytes(pcm[: len(pcm) // 2 * 2])
    if src_rate == dst_rate or not src:
        return pcm
    n_dst = int(len(src) * dst_rate / src_rate)
    dst = array.array("h", bytes(2 * n_dst))
    for i in range(n_dst):
        pos = i * (len(src) - 1) / max(n_dst - 1, 1)
        lo = int(pos)
        hi = min(lo + 1, len(src) - 1)
        frac = pos - lo
        dst[i] = int(src[lo] * (1 - frac) + src[hi] * frac)
    return dst.tobytes()


def wav_header_strip(data: bytes):
    """从 WAV 字节流中提取 (sample_rate, pcm_bytes)；非 WAV 则原样返回。"""
    if data[:4] != b"RIFF":
        return None, data
    import struct

    sr = struct.unpack("<I", data[24:28])[0]
    idx = data.find(b"data")
    if idx < 0:
        return sr, data[44:]
    return sr, data[idx + 8 :]


def write_wav(path: Path, pcm: bytes, rate: int):
    import struct

    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + len(pcm)))
        f.write(b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16))
        f.write(b"data")
        f.write(struct.pack("<I", len(pcm)))
        f.write(pcm)


def save_report(name: str, result: dict):
    path = OUTPUT / f"{name}.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
