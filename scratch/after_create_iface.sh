docker exec nxp-ca7b24f0 python3 -c "
with open('/tmp/relay_all.log') as f:
    found = False
    count = 0
    for line in f:
        if 'lsteamclient.CreateInterface' in line:
            found = True
        if found:
            print(line.strip())
            count += 1
            if count >= 80:
                break
"
