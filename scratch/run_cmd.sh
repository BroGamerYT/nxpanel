docker exec nxp-ca7b24f0 grep -o -E 'module=[0-9a-fA-F]+ L"[^"]+"' /tmp/relay_all.log | sort -u
