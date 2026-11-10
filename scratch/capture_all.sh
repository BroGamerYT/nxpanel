#!/bin/bash
PCAP=/tmp/all_traffic.pcap
rm -f "$PCAP"

echo "Starting tcpdump for all non-SSH traffic..."
tcpdump -i any -n "not port 22" -w "$PCAP" &
TCPDUMP_PID=$!
sleep 1

echo "Starting test_direct_run.sh inside container..."
docker exec -u container nxp-ca7b24f0 bash /home/container/test_direct_run.sh

echo "Stopping tcpdump..."
kill -2 $TCPDUMP_PID
wait $TCPDUMP_PID 2>/dev/null

echo "Analyzing distinct IP connections:"
tcpdump -r "$PCAP" -n "tcp or udp" | awk '{print $3 " -> " $5}' | sort -u | head -n 40
