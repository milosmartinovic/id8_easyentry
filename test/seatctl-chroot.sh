#!/bin/sh
# test only: runs the head-unit build of seatctl in the bionic chroot, against a real vsomeip
exec env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LD_LIBRARY_PATH=/usr/local/lib VSOMEIP_CONFIGURATION=/build/t/vsomeip-test.json chroot /opt/bionic /build/t/seatctl "$@"
