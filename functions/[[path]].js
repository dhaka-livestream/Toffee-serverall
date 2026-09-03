// ========================================
//  সিম্পল ও কার্যকরী স্ট্রিম প্রক্সি (Pages Functions)
// ========================================

const CONFIG_URL = 'https://raw.githubusercontent.com/dhaka-livestream/Toffee-serverall/refs/heads/main/channels.json';
const SECRET_PARAM = 'tlmony.netlify.app';
const SECRET_VALUE = 'sadullapur';

let configCache = null;
let cacheTime = 0;
const CACHE_TTL = 60000;

async function getConfig() {
  const now = Date.now();
  if (configCache && now - cacheTime < CACHE_TTL) {
    return configCache;
  }
  const resp = await fetch(CONFIG_URL);
  if (!resp.ok) throw new Error('Config fetch failed');
  configCache = await resp.json();
  cacheTime = now;
  return configCache;
}

async function getChannel(id) {
  const config = await getConfig();
  return config.channels.find(c => c.id === id);
}

// ---------- প্লেলিস্ট রিরাইট (শুধু URL প্রতিস্থাপন) ----------
function rewriteUrls(content, channelId, baseUrl, baseChannelUrl) {
  const lines = content.split('\n');
  const rewritten = lines.map(line => {
    // মন্তব্য বা খালি লাইন অপরিবর্তিত রাখুন
    if (line.trim().startsWith('#') || !line.trim()) return line;

    // URI="..." হ্যান্ডেল (DRM কী বা ম্যাপ)
    if (line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (_, url) => {
        try {
          const resolved = new URL(url, baseChannelUrl).href;
          return `URI="${baseUrl}/raw/${channelId}?url=${encodeURIComponent(resolved)}&${SECRET_PARAM}=${SECRET_VALUE}"`;
        } catch {
          return line;
        }
      });
    }

    // সাধারণ ইউআরএল
    try {
      const resolved = new URL(line.trim(), baseChannelUrl).href;
      // শুধুমাত্র .ts বা .m3u8 ফাইলগুলো প্রক্সি করুন
      if (resolved.match(/\.(ts|m3u8)(\?.*)?$/i)) {
        return `${baseUrl}/raw/${channelId}?url=${encodeURIComponent(resolved)}&${SECRET_PARAM}=${SECRET_VALUE}`;
      }
      return line;
    } catch {
      return line;
    }
  });
  return rewritten.join('\n');
}

// ============================================================
//  মূল হ্যান্ডলার
// ============================================================
export async function onRequest(context) {
  try {
    const { request } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const baseUrl = `${url.protocol}//${url.hostname}`;

    // ----- সিক্রেট প্যারামিটার চেক -----
    if (url.searchParams.get(SECRET_PARAM) !== SECRET_VALUE) {
      return new Response('Forbidden', { status: 403 });
    }

    // ----- 1. প্লেলিস্ট (/play/xxx.m3u8) -----
    let channelId = null;
    const m3u8Match = path.match(/^\/play\/(.+)\.m3u8$/);
    if (m3u8Match) {
      channelId = m3u8Match[1];
    } else if (path.startsWith('/play/')) {
      const parts = path.split('/');
      if (parts.length >= 3) channelId = parts[2];
    }

    if (channelId) {
      const channel = await getChannel(channelId);
      if (!channel) {
        return new Response(`Channel not found: ${channelId}`, { status: 404 });
      }

      // হেডার তৈরি
      const headers = new Headers();
      headers.set('User-Agent', channel.user_agent || 'okhttp/5.1.0');
      if (channel.cookie) headers.set('Cookie', channel.cookie);

      // মূল প্লেলিস্ট ফেচ
      const originResp = await fetch(channel.url, { headers });
      if (!originResp.ok) {
        return new Response(`Upstream error: ${originResp.status}`, { status: 502 });
      }

      const contentType = originResp.headers.get('Content-Type') || 'application/vnd.apple.mpegurl';
      const bodyText = await originResp.text();

      // ইউআরএল রিরাইট
      const rewritten = rewriteUrls(bodyText, channelId, baseUrl, channel.url);

      return new Response(rewritten, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // ----- 2. সেগমেন্ট প্রক্সি (/raw/xxx?url=...) -----
    if (path.startsWith('/raw/')) {
      const parts = path.split('/');
      const channelId = parts[2];
      const targetUrl = url.searchParams.get('url');
      if (!channelId || !targetUrl) {
        return new Response('Missing parameters', { status: 400 });
      }

      const channel = await getChannel(channelId);
      if (!channel) {
        return new Response(`Channel not found: ${channelId}`, { status: 404 });
      }

      const headers = new Headers();
      headers.set('User-Agent', channel.user_agent || 'okhttp/5.1.0');
      if (channel.cookie) headers.set('Cookie', channel.cookie);

      const segmentResp = await fetch(decodeURIComponent(targetUrl), { headers });
      if (!segmentResp.ok) {
        return new Response(`Segment error: ${segmentResp.status}`, { status: 502 });
      }

      const contentType = segmentResp.headers.get('Content-Type') || '';

      // যদি সাব-প্লেলিস্ট হয়, রিরাইট করে দিতে হবে
      if (contentType.includes('mpegurl') || contentType.includes('vnd.apple.mpegurl')) {
        const body = await segmentResp.text();
        const rewritten = rewriteUrls(body, channelId, baseUrl, decodeURIComponent(targetUrl));
        return new Response(rewritten, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          },
        });
      }

      // .ts ফাইল – সরাসরি পাস
      return new Response(segmentResp.body, {
        status: segmentResp.status,
        headers: {
          'Content-Type': contentType || 'video/MP2T',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    return new Response('Not Found', { status: 404 });

  } catch (error) {
    console.error('Error:', error);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
