import socket

hosts = [
    "fs25-b.farming-simulator.com",
    "fs25-a.farming-simulator.com",
    "master.farming-simulator.com",
    "account.farming-simulator.com"
]

for host in hosts:
    try:
        ip = socket.gethostbyname(host)
        print(f"{host} -> {ip}")
        for port in [10881, 10880, 80, 443]:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(2.0)
            res = s.connect_ex((ip, port))
            status = "OPEN" if res == 0 else f"ERR {res}"
            print(f"  TCP {port}: {status}")
            s.close()
    except Exception as e:
        print(f"{host} FAILED: {e}")
