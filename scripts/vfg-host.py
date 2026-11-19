"""KittyPlays Native Messaging bootstrap and local VFG frame transport."""

import hmac
import json
import os
import secrets
import struct
import sys
import threading

MAX_FRAME = 1920 * 1080 * 4
HEADER = struct.Struct("<HHB")


def announce(**message):
    payload = json.dumps(message).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(payload)) + payload)
    sys.stdout.buffer.flush()


def exit_on_disconnect():
    # Chrome owns the lifetime of this host through the native messaging pipe.
    while sys.stdin.buffer.read(4096):
        pass
    os._exit(0)


def main():
    import torch
    from nvvfx import VideoFrameGeneration
    from websockets.exceptions import ConnectionClosed
    from websockets.sync.server import serve

    if not torch.cuda.is_available():
        raise RuntimeError("NVIDIA VFG requires a working CUDA driver and a supported RTX GPU")
    token = secrets.token_hex(32)
    session = threading.Lock()
    threading.Thread(target=exit_on_disconnect, daemon=True).start()

    def handle(socket):
        effect = None
        try:
            supplied = socket.recv(timeout=3)
            if not isinstance(supplied, str) or not hmac.compare_digest(supplied.encode(), token.encode()):
                socket.close(1008, "Authentication required")
                return
        except (TimeoutError, ConnectionClosed):
            return
        if not session.acquire(blocking=False):
            socket.close(1008, "Session already active")
            return
        try:
            stream = torch.cuda.current_stream()
            previous = dimensions = None
            socket.send("ready")
            for message in socket:
                if not isinstance(message, bytes) or len(message) < HEADER.size:
                    raise ValueError("Invalid NVIDIA VFG frame")
                width, height, multiplier = HEADER.unpack_from(message)
                if not (2 <= width <= 1920 and 2 <= height <= 1080
                        and 1 <= multiplier <= 8
                        and len(message) == HEADER.size + width * height * 4):
                    raise ValueError("Invalid NVIDIA VFG frame dimensions")
                raw = torch.frombuffer(bytearray(message[HEADER.size:]), dtype=torch.uint8)
                current = (raw.to("cuda").view(height, width, 4)[..., :3]
                           .permute(2, 0, 1).contiguous().float().div_(255))
                if dimensions != (width, height):
                    if effect is not None:
                        effect.close()
                    effect = None
                    previous = None
                    dimensions = (width, height)
                if previous is None or multiplier == 1:
                    socket.send(b"")
                else:
                    if effect is None:
                        effect = VideoFrameGeneration(mode=VideoFrameGeneration.Mode.MEDIUM, device=0)
                        effect.input_width, effect.input_height = dimensions
                        effect.load()
                    effect.frame_multiplier = multiplier
                    rgba = torch.full((multiplier - 1, height, width, 4), 255, device="cuda", dtype=torch.uint8)
                    for index in range(1, multiplier):
                        result = effect.run(previous, current, frame_index=index, stream_ptr=stream.cuda_stream)
                        rgb = torch.from_dlpack(result.image).mul(255).round_().clamp_(0, 255).to(torch.uint8)
                        rgba[index - 1, ..., :3] = rgb.permute(1, 2, 0)
                    socket.send(rgba.cpu().numpy().tobytes())
                previous = current
        except ConnectionClosed:
            pass
        except Exception as error:
            try:
                socket.send(f"NVIDIA VFG: {error}")
            except ConnectionClosed:
                pass
        finally:
            try:
                if effect is not None:
                    effect.close()
            finally:
                session.release()

    with serve(handle, "127.0.0.1", 0, origins=["https://www.youtube.com"],
               compression=None, max_size=MAX_FRAME + HEADER.size, max_queue=1) as server:
        announce(port=server.socket.getsockname()[1], token=token, version=2)
        server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        announce(error=f"NVIDIA VFG: {error}")
