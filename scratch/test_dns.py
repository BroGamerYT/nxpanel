import socket
print("Testing getaddrinfo on Linux:")
print(socket.getaddrinfo("modhub.giants-software.com", 443))
print(socket.getaddrinfo("fs25-b.farming-simulator.com", 10881))
