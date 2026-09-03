// ============================================================
//  ডিবাগ-বান্ধব ও স্থিতিশীল স্ট্রিম প্রক্সি (Pages Functions)
// ============================================================

const CONFIG_URL = 'https://raw.githubusercontent.com/your-username/your-repo/main/channels.json';
const SECRET_PARAM = 'tlmony.netlify.app';
const SECRET_VALUE = 'sadullapur';

// ---------- ক্যাশ ব্যবস্থাপনা ----------
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60000; // ১ মিনিট

// ---------- কনফিগ লোড (GitHub থেকে) ----------
async function getChannelConfig(channelId) {
  try {
    const now = Date.now();
    if (cache.data && now - cache.timestamp < CACHE_TTL) {
      const channel = cache.data.channels.find(c => c.id === channelId);
      if (channel) return channel;
    }
    
    const resp = await fetch(CONFIG_URL);
    if (!resp.ok) throw new Error(`Config fetch failed: ${resp.status}`);
    const data = await resp.json();
    cache.data = data;
    cache.timestamp = now;
    
    return data.channels.find(c => c.id === channelId);
  } catch (error) {
    console.error('Config load error:', error);
    throw error;
  }
}

// ---------- প্লেলিস্ট রিরাইট (শুধু URL প্রতিস্থাপন) ----------
function rewritePlaylist(content, channelId, baseUrl, baseChannelUrl) {
  try {
    const lines = content.split('\n');
    return lines.map(line => {
      if (line.startsWith('#') || !line.trim()) return line;

      // URI="..." (DRM কী বা ম্যাপ)
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
  } catch (error) {
    console.error('Rewrite error:', error);
    return content; // error হলে original content return করুন
  }
}

// ============================================================
//   মূল হ্যান্ডলার (স্ট্রিমিং + ক্যাশিং + লো-লেটেন্সি)
// ============================================================
export async function onRequest(context) {
  try {
    const { request } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const baseUrl = `${url.protocol}//${url.hostname}`;

    // ----- সিক্রেট প্যারামিটার চেক (সব রিকোয়েস্টে) -----
    if (url.searchParams.get(SECRET_PARAM) !== SECRET_VALUE) {
      return new Response('Forbidden: Invalid or missing secret parameter', { 
        status: 403,
        headers: { 'Content-Type': 'text/plain' }
      });
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
      if (!channel) {
        return new Response(`Channel "${channelId}" not found`, { status: 404 });
      }

      // হেডার তৈরি
      const headers = new Headers();
      headers.set('User-Agent', channel.user_agent || 'okhttp/5.1.0');
      if (channel.cookie) headers.set('Cookie', channel.cookie);
      headers.set('Accept-Encoding', 'gzip, deflate, br');

      // মূল প্লেলিস্ট ফেচ
      const originResp = await fetch(channel.url, { headers });
      if (!originResp.ok) {
        return new Response(`Upstream error: ${originResp.status}`, { status: 502 });
      }

      const bodyText = await originResp.text();
      const rewritten = rewritePlaylist(bodyText, channelId, baseUrl, channel.url);

      return new Response(rewritten, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    }

    // ----- 2. সেগমেন্ট প্রক্সি (/raw/xxx?url=...&secret=...) -----
    if (path.startsWith('/raw/')) {
      const parts = path.split('/');
      const channelId = parts[2];
      const targetUrl = url.searchParams.get('url');
      if (!channelId || !targetUrl) {
        return new Response('Missing channelId or url parameter', { status: 400 });
      }

      const channel = await getChannelConfig(channelId);
      if (!channel) {
        return new Response(`Channel "${channelId}" not found`, { status: 404 });
      }

      const headers = new Headers();
      headers.set('User-Agent', channel.user_agent || 'okhttp/5.1.0');
      if (channel.cookie) headers.set('Cookie', channel.cookie);
      headers.set('Accept-Encoding', 'gzip, deflate, br');

      // সেগমেন্ট ফেচ
      const segmentResp = await fetch(decodeURIComponent(targetUrl), { headers });
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

      // ভিডিও সেগমেন্ট (.ts) – সরাসরি পাস
      return new Response(segmentResp.body, {
        status: segmentResp.status,
        headers: {
          'Content-Type': contentType || 'video/MP2T',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        },
      });
    }

    return new Response('Not Found. Use /play/channel_id.m3u8?tlmony.netlify.app=sadullapur', { 
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    });

  } catch (error) {
    // সব ধরণের error ধরা এবং লগ করা
    console.error('Unhandled error:', error);
    return new Response(`Internal Server Error: ${error.message}`, { 
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}
