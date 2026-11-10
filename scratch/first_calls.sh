docker exec nxp-ca7b24f0 python3 -c "
with open('/tmp/relay_all.log') as f:
    count = 0
    for line in f:
        if line.startswith('0238:'):
            print(line.strip())
            count += 1
            if count >= 60:
                break
"
