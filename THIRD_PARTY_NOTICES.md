# Third-party sources and licenses

This repository contains independently written bridge/client code extracted from the owner's private QQ integration, then generalized and sanitized. Its Git history begins at this public release. No third-party implementation was vendored, and no private configuration, chat transcript, model weight, QQ binary or NapCat source is included.

Dependencies are installed separately. Their terms are not replaced by this repository's MIT license:

- **NapCatQQ**: external QQ/OneBot runtime. Upstream currently uses a custom **Limited Redistribution License for NapCat**, including non-commercial restrictions and restrictions on publicly releasing modified code. Read the actual version's terms before installing, modifying or redistributing it. This repository only calls its interfaces and does not package its code. [Source and license](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE), [official setup documentation](https://napneko.github.io/guide/napcat).
- **QQ**: proprietary Tencent application used by the external runtime. Obtain it through official channels and comply with applicable service terms. No login session, application files, assets or account data are distributed here.
- **Python cryptography**: Python client dependency, version pinned in `client/requirements.txt`. Upstream offers Apache-2.0 or BSD-3-Clause; its wheels may include further dependencies. [Source and license](https://github.com/pyca/cryptography/blob/main/LICENSE).
- **Pillow**: image validation dependency, version pinned in `server/requirements.txt`. MIT-CMU; binary distributions may include separately licensed image libraries. [Source and license](https://github.com/python-pillow/Pillow/blob/main/LICENSE).
- **Node.js**: external runtime, includes bundled components such as SQLite. [Runtime license and notices](https://github.com/nodejs/node/blob/main/LICENSE).
- **Python**: external runtime. [License](https://docs.python.org/3/license.html).
- **FFmpeg/ffprobe**: optional external audio tools, not bundled. Licensing depends on build options and linked components. [Official licensing information](https://ffmpeg.org/legal.html).
- **Docker** and **curl**: external transport tools, not bundled. [Docker Engine licensing](https://github.com/moby/moby/blob/master/LICENSE), [curl license](https://curl.se/docs/copyright.html).

The bridge retains the existing `napcat-*-v1` protocol strings for compatibility; those names do not imply affiliation or endorsement. Test images and audio are synthetic fixtures. No speech model, character asset or TTS implementation is part of this release.

License review performed on 2026-10-06. Check the exact upstream version you install; this list is attribution and deployment guidance, not a claim that external components share one license.
