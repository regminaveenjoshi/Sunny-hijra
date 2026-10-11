import asyncio
import base64
import os
from pathlib import Path

import pyrogram.errors as pyrogram_errors

# Compatibility fix for PyTgCalls/Pyrogram exception-name mismatch.
if (
    not hasattr(pyrogram_errors, "GroupCallForbidden")
    and hasattr(pyrogram_errors, "GroupcallForbidden")
):
    pyrogram_errors.GroupCallForbidden = pyrogram_errors.GroupcallForbidden

from pyrogram import Client
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream
from pytgcalls.types.stream import StreamEnded


# Railway variable SESSION_FILE_B64 should contain the Base64-encoded
# telegram_user_session.session file. Never print its contents.
SESSION_NAME = "telegram_user_session"
SESSION_FILE = Path(f"{SESSION_NAME}.session")
# Railway limits the length of a single variable, so the Base64 data
# can be split across SESSION_FILE_B64_1 and SESSION_FILE_B64_2.
session_file_b64 = (
    os.getenv("SESSION_FILE_B64", "")
    or os.getenv("SESSION_FILE_B64_1", "") + os.getenv("SESSION_FILE_B64_2", "")
)

if session_file_b64 and not SESSION_FILE.exists():
    SESSION_FILE.write_bytes(base64.b64decode(session_file_b64))

# Set these in Railway Variables; don't hard-code secrets in source code.
API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
CHAT_ID = int(os.getenv("CHAT_ID", "-1004417866505"))
AUDIO_FILE = os.getenv("AUDIO_FILE", "audio.mp3")

app = Client(
    "telegram_user_session",
    api_id=API_ID,
    api_hash=API_HASH,
)

calls = PyTgCalls(app)
play_lock = asyncio.Lock()


async def play_recording(chat_id: int) -> None:
    if not os.path.isfile(AUDIO_FILE):
        raise FileNotFoundError(f"MP3 not found: {AUDIO_FILE}")

    async with play_lock:
        await calls.play(chat_id, MediaStream(AUDIO_FILE))
        print(f"Playing MP3 in group {chat_id}")


@calls.on_update()
async def on_update(_, update):
    if isinstance(update, StreamEnded) and update.chat_id == CHAT_ID:
        await asyncio.sleep(0.5)
        await play_recording(CHAT_ID)


async def main():
    if not os.path.isfile(AUDIO_FILE):
        raise FileNotFoundError(
            f"{AUDIO_FILE} not found. Upload your MP3 with this exact filename."
        )

    await app.start()
    await calls.start()
    print("Telegram client started.")
    print("Make sure the target group voice chat is already active.")
    await play_recording(CHAT_ID)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
