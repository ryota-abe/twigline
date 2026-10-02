#!/bin/sh
# Started directly by git / ssh as GIT_ASKPASS / SSH_ASKPASS.
# The response is received through a temporary file (stdout cannot be relied on when Electron runs as node).
TWIGLINE_ASKPASS_OUT=`mktemp`
ELECTRON_RUN_AS_NODE="1" TWIGLINE_ASKPASS_OUT="$TWIGLINE_ASKPASS_OUT" "$TWIGLINE_HELPER_NODE" "$TWIGLINE_ASKPASS_MAIN" "$@"
status=$?
cat "$TWIGLINE_ASKPASS_OUT"
rm -f "$TWIGLINE_ASKPASS_OUT"
exit $status
