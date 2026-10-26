#!/bin/sh
set -eu
cd /workspace/.home
exec xterm -title "Terminal - $(id -un)@$(hostname): ~" \
  -fa 'DejaVu Sans Mono' -fs 12 -geometry 92x28+100+80 \
  -bg '#1e2229' -fg '#f0f0f0' \
  -xrm 'XTerm*selectToClipboard: true' \
  -xrm 'XTerm*VT100.translations: #override \n Ctrl Shift <Key>C: copy-selection(CLIPBOARD) \n Ctrl Shift <Key>V: insert-selection(CLIPBOARD)' \
  -e /bin/bash --noprofile --norc -i
