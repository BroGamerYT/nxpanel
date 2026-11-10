import urllib.request
import urllib.parse
import http.cookiejar
import re

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

# 1. Login
login_data = urllib.parse.urlencode({
    'username': 'admin',
    'password': 'test123!',
    'login': 'Login'
}).encode()

res = opener.open('http://172.20.0.6:28005/index.html?lang=en', data=login_data)
html = res.read().decode('utf-8', errors='ignore')

print("Cookies after login:", [c.name + '=' + c.value for c in cj])
print("Res URL:", res.geturl())
if "login" in res.geturl() or "name=\"login\"" in html:
    print("LOGIN FAILED!")
else:
    print("LOGIN SUCCESSFUL!")

# Extract form 0
forms = re.findall(r'<form[\s\S]*?</form>', html)
if not forms:
    print('No forms found')
    exit(1)

form = forms[0]

# Parse inputs
post_data = {}
for inp in re.finditer(r'<input\s+[^>]*name\s*=\s*["\']([^"\']+)["\'][^>]*>', form, re.IGNORECASE):
    tag = inp.group(0)
    name = inp.group(1)
    if 'type="submit"' in tag or "type='submit'" in tag or 'type="checkbox"' in tag:
        continue
    val_m = re.search(r'value=["\']([^"\']*)["\']', tag)
    val = val_m.group(1) if val_m else ''
    post_data[name] = val

# Parse selects (selected option)
for sel in re.finditer(r'<select\s+[^>]*name\s*=\s*["\']([^"\']+)["\'][\s\S]*?</select>', form, re.IGNORECASE):
    name = sel.group(1)
    block = sel.group(0)
    opt_m = re.search(r'<option[^>]*selected[^>]*value=["\']([^"\']*)["\']', block)
    if not opt_m:
        opt_m = re.search(r'<option[^>]*value=["\']([^"\']*)["\']', block)
    val = opt_m.group(1) if opt_m else ''
    post_data[name] = val

# Add start action
post_data['start_server'] = 'Start'

print("Form parameters to submit:")
for k, v in post_data.items():
    print(f"  {k} = {v}")

print("\nSubmitting Start to dedicatedServer...")
start_req = opener.open('http://172.20.0.6:28005/index.html?lang=en', data=urllib.parse.urlencode(post_data).encode())
res_body = start_req.read().decode('utf-8', errors='ignore')

# Save res_body to file
with open('/home/container/after_start.html', 'w', encoding='utf-8') as f:
    f.write(res_body)

# Search for errors or messages
messages = re.findall(r'<div class="callout[^"]*"[^>]*>([\s\S]*?)</div>', res_body)
print("Callouts / Alerts:", messages)

if 'ONLINE' in res_body:
    print("\nSUCCESS: Status changed to ONLINE!")
elif 'OFFLINE' in res_body:
    print("\nResult: Still OFFLINE or Starting...")
else:
    print("\nResult unknown, body length:", len(res_body))
