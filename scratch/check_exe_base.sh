docker exec nxp-ca7b24f0 python3 -c "
with open('/tmp/relay_all.log') as f:
    for line in f:
        if 'FarmingSimulator2025Game.exe' in line:
            print(line.strip())
            break
"
