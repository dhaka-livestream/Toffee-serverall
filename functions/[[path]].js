// ===============================
// অপটিমাইজড স্ট্রিম প্রক্সি (Pages Functions)
// ===============================

const CONFIG_URL = 'https://raw.githubusercontent.com/your-username/your-repo/main/channels.json';
const SECRET_PARAM = 'tlmony.netlify.app';
const SECRET_VALUE = 'sadullapur';

// ---------- ক্যাশ ব্যবস্থাপনা ----------
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60000; // ১ মিনিট (শুধু কনফিগের জন্য)

// ---------- কনফিগ লোড (GitHub থেকে) ----------
async function getChannelConfig(channelId) {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return cache.data.channels.find(c => c.id === channelId);
  }
  const resp = await fetch(CONFIG_URL, { cf: { cacheTtl: 60 } }); // CF এজ ক্যাশ
  if (!resp.ok) throw new Error('Config fetch failed');
  const data = await resp.json();
  cache.data = data;
  cache.timestamp = now;
  return data.channels.find(c => c.id === channelId);
}

// ---------- প্লেলিস্ট রিরাইট (শুধু URL প্রতিস্থাপন) ----------
function rewritePlaylist(content, channelId, baseUrl, baseChannelUrl) {
  const lines = content.split('\n');
  return lines.map(line => {
    if (line.startsWith('#') || !line.trim()) return line;

    // URI="..." (DRM কী বা ম্যাপ)
    if (line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (_, url) => {
        const resolved = new URL(url, baseChannelUrl).href;
        const proxy = `${baseUrl}/raw/${channelId}?url=${encodeURIComponent(resolved)}&${SECRET_PARAM}=${SECRET_VALUE}`;
        return `URI="${proxy}"`;
      });
    }

    // সাধারণ .ts বা .m3u8 লিংক
    try {
      const resolved = new URL(line.trim(), baseChannelUrl).href;
      if (resolved.includes('.ts') || resolved.includes('.m3u8')) {
        return `${baseUrl}/raw/${channelId}?url=${encodeURIComponent(resolved)}&${SECRET_PARAM}=${SECRET_VALUE}`;
      }
      return line;
    } catch {
      return line;
    }
  }).join('\n');
}

// ============================================================
//   মূল হ্যান্ডলার (স্ট্রিমিং + ক্যাশিং + লো-লেটেন্সি)
// ============================================================
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const baseUrl = `${url.protocol}//${url.hostname}`;

  // ----- সিক্রেট প্যারামিটার চেক (সব রিকোয়েস্টে) -----
  if (url.searchParams.get(SECRET_PARAM) !== SECRET_VALUE) {
    return new Response('Forbidden', { status: 403 });
  }

  // ----- 1. প্লেলিস্ট এন্ডপয়েন্ট (/play/xxx.m3u8) -----
  let channelId = null;
  const m3u8Match = path.match(/^\/play\/(.+)\.m3u8$/);
  if (m3u8Match) {
    channelId = m3u8Match[1];
  } else if (path.startsWith('/play/')) {
    const parts = path.split('/');
    if (parts.length >= 3) channelId = parts[2];
  }

  if (channelId) {
    const channel = await getChannelConfig(channelId);
    if (!channel) return new Response('Channel not found', { status: 404 });

    // হেডার তৈরি
    const headers = new Headers();
    headers.set('User-Agent', channel.user_agent || 'okhttp/5.1.0');
    if (channel.cookie) headers.set('Cookie', channel.cookie);
    headers.set('Accept-Encoding', 'gzip, deflate, br'); // কম্প্রেশন সাপোর্ট

    // মূল প্লেলিস্ট ফেচ (টাইমআউট বাড়ানো)
    const originResp = await fetch(channel.url, {
      headers,
      cf: { cacheTtl: 0, cacheKey: `playlist-${channelId}` }
    });

    if (!originResp.ok) {
      return new Response(`Upstream error: ${originResp.status}`, { status: 502 });
    }

    const bodyText = await originResp.text();
    const rewritten = rewritePlaylist(bodyText, channelId, baseUrl, channel.url);

    // প্লেলিস্ট ক্যাশ করা হবে না (সর্বদা লাইভ)
    return new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  }

  // ----- 2. সেগমেন্ট প্রক্সি (/raw/xxx?url=...&secret=...) -----
  if (path.startsWith('/raw/')) {
    const parts = path.split('/');
    const channelId = parts[2];
    const targetUrl = url.searchParams.get('url');
    if (!channelId || !targetUrl) {
      return new Response('Missing parameters', { status: 400 });
    }

    const channel = await getChannelConfig(channelId);
    if (!channel) return new Response('Channel not found', { status: 404 });

    const headers = new Headers();
    headers.set('User-Agent', channel.user_agent || 'okhttp/5.1.0');
    if (channel.cookie) headers.set('Cookie', channel.cookie);
    headers.set('Accept-Encoding', 'gzip, deflate, br');

    // ----- সেগমেন্ট ফেচ (স্ট্রিমিং মোড) -----
    const segmentResp = await fetch(decodeURIComponent(targetUrl), {
      headers,
      cf: {
        // Cloudflare CDN ক্যাশ (সেগমেন্ট ১ ঘন্টা পর্যন্ত রাখা যেতে পারে)
        cacheTtl: 3600,
        cacheKey: `segment-${channelId}-${targetUrl}`,
        // টিয়ার্ড ক্যাশিং চালু (দ্রুত ডেলিভারি)
        tieredCache: true,
      }
    });

    if (!segmentResp.ok) {
      return new Response(`Segment error: ${segmentResp.status}`, { status: 502 });
    }

    const contentType = segmentResp.headers.get('Content-Type') || '';

    // যদি সাব-প্লেলিস্ট হয় (ভ্যারিয়েন্ট), তাহলে সেটাও রিরাইট করতে হবে
    if (contentType.includes('mpegurl') || contentType.includes('vnd.apple.mpegurl')) {
      const body = await segmentResp.text();
      const rewritten = rewritePlaylist(body, channelId, baseUrl, decodeURIComponent(targetUrl));
      return new Response(rewritten, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    }

    // ----- ভিডিও সেগমেন্ট (.ts) – সরাসরি স্ট্রিম (পাইপ) -----
    // এখানে কোনো প্রসেসিং নেই – পুরো বডি পাস করে দিই
    return new Response(segmentResp.body, {
      status: segmentResp.status,
      headers: {
        'Content-Type': contentType || 'video/MP2T',
        'Content-Length': segmentResp.headers.get('Content-Length'),
        'Access-Control-Allow-Origin': '*',
        // CDN-এ ১ ঘন্টা ক্যাশ রাখি (স্ট্রিমিং এর জন্য)
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'Accept-Ranges': 'bytes', // পার্টিয়াল রিকোয়েস্ট সাপোর্ট
      },
    });
  }

  return new Response('Not Found', { status: 404 });
}
