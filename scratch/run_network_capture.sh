#!/bin/bash
PCAP=/tmp/giants_trace.pcap
rm -f "$PCAP"

echo "Starting tcpdump..."
tcpdump -i any -n "host 5.9.5.168 or port 28007" -w "$PCAP" &
TCPDUMP_PID=$!
sleep 1

echo "Starting test_direct_run.sh inside container..."
docker exec -u container nxp-ca7b24f0 bash /home/container/test_direct_run.sh

echo "Stopping tcpdump..."
kill -2 $TCPDUMP_PID
wait $TCPDUMP_PID 2>/dev/null

echo "Analyzing packets:"
tcpdump -r "$PCAP" -n -X | head -n 120
