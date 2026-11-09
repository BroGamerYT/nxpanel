const res = await fetch('https://internet.nl/site/nxp.brogameryt.de/4399543/');
const html = await res.text();

const re = /<h3[^>]*>([\s\S]*?)<\/h3>/g;
let m;
while ((m = re.exec(html)) !== null) {
  const title = m[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
  console.log('H3:', title);
}


