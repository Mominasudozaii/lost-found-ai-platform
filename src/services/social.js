const { tokenize } = require("./matching");

const version = process.env.META_API_VERSION || "v21.0";
const base = `https://graph.facebook.com/${version}`;

function configured() {
  return Boolean(process.env.META_ACCESS_TOKEN && (process.env.META_IG_USER_ID || process.env.META_FACEBOOK_PAGE_ID));
}

function filterPosts(posts, query) {
  const words = tokenize(query);
  return posts.filter((post) => {
    const body = `${post.caption || ""} ${post.message || ""}`.toLowerCase();
    return words.some((word) => body.includes(word));
  });
}

async function graph(path) {
  const url = new URL(`${base}/${path}`);
  url.searchParams.set("access_token", process.env.META_ACCESS_TOKEN);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Meta Graph API returned ${response.status}`);
  return response.json();
}

// Meta does not provide unrestricted search of all public Facebook/Instagram posts.
// This adapter searches media the connected Business/Creator account or Page is permitted to read.
async function searchSocial(query) {
  if (!configured()) return { configured: false, results: [], limitation: "Connect a Meta Business/Page access token to search authorized public-facing media." };
  const results = [];
  if (process.env.META_IG_USER_ID) {
    const media = await graph(`${process.env.META_IG_USER_ID}/media?fields=id,caption,media_type,media_url,permalink,timestamp&limit=100`);
    results.push(...filterPosts(media.data || [], query).map((post) => ({ source: "instagram", title: post.caption?.slice(0, 120) || "Instagram post", excerpt: post.caption || "", url: post.permalink, imageUrl: post.media_type === "IMAGE" ? post.media_url : null, publishedAt: post.timestamp })));
  }
  if (process.env.META_FACEBOOK_PAGE_ID) {
    const posts = await graph(`${process.env.META_FACEBOOK_PAGE_ID}/posts?fields=id,message,permalink_url,created_time,full_picture&limit=100`);
    results.push(...filterPosts(posts.data || [], query).map((post) => ({ source: "facebook", title: post.message?.slice(0, 120) || "Facebook post", excerpt: post.message || "", url: post.permalink_url, imageUrl: post.full_picture || null, publishedAt: post.created_time })));
  }
  return { configured: true, results, limitation: "Results are limited to content your approved Meta app is authorized to read." };
}

module.exports = { searchSocial, configured };
