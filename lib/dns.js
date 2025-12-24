export async function dohLookup(name, type = "A") {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);

  const resp = await fetch(url.toString(), {
    headers: { "accept": "application/dns-json" }
  });

  if (!resp.ok) throw new Error("DoH request failed");
  const data = await resp.json();
  return (data.Answer || []).map(a => a.data);
}
