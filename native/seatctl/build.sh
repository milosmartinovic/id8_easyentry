#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds seatctl for the head unit: x86-64, gcc 7 / glibc 2.27 / libstdc++ 6.0.24 (Ubuntu 18.04),
# linked against a link-only stub of the unit's libvsomeip3.so.3, then ABI-checked.
#
#   ./build.sh                    inside an Ubuntu 18.04 amd64 userland (Docker image ubuntu:18.04 with
#                                 g++ make binutils python3, or a debootstrap'd bionic chroot)
#   BIONIC=/opt/bionic ./build.sh  from a newer host: runs the build in that chroot
#
# Output: build/seatctl, copied to ../../tools/mm-easy-entry/seatctl
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -n "${BIONIC:-}" ]; then
    rm -rf "$BIONIC/build/seatctl" && mkdir -p "$BIONIC/build/seatctl"
    cp -r "$HERE/seatctl.cpp" "$HERE/build.sh" "$HERE/third_party" "$HERE/abi" "$HERE/tools" "$BIONIC/build/seatctl/"
    env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin chroot "$BIONIC" /bin/dash -c 'cd /build/seatctl && /bin/dash ./build.sh'
    mkdir -p "$HERE/build" && cp "$BIONIC/build/seatctl/build/seatctl" "$HERE/build/seatctl"
else
    cd "$HERE"
    mkdir -p build/stub
    python3 tools/abi.py stub abi/libvsomeip3.so.3.symbols build/stub/vsomeip_stub.S
    g++ -shared -nostdlib -Wl,-soname,libvsomeip3.so.3 -o build/stub/libvsomeip3.so.3 build/stub/vsomeip_stub.S
    g++ -std=c++14 -O2 -Wall -Wextra -Werror -isystem third_party/vsomeip/interface \
        -o build/seatctl seatctl.cpp build/stub/libvsomeip3.so.3 -lpthread \
        -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -Wl,--as-needed
    strip build/seatctl
    python3 tools/abi.py check build/seatctl abi/libvsomeip3.so.3.symbols
fi
if [ -d "$HERE/../../tools/mm-easy-entry" ]; then cp "$HERE/build/seatctl" "$HERE/../../tools/mm-easy-entry/seatctl"; fi
echo "seatctl built: $HERE/build/seatctl"
