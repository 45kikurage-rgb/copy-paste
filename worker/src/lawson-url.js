// Keep coupon credentials and query bytes intact; change only the known route.
export function lawsonLoginUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "apli.lawson.jp" ||
        url.username || url.password || (url.port && url.port !== "443") ||
        !/^\/ldcp\/(?:coupon|login)\/?$/.test(url.pathname)) return null;
    const campaigns = url.searchParams.getAll("campaignId");
    const codes = url.searchParams.getAll("encDataCode");
    if (campaigns.length !== 1 || !/^[A-Za-z0-9_-]{1,100}$/.test(campaigns[0]) ||
        codes.length !== 1 || !/^[A-Za-z0-9_+\/-]{8,512}={0,2}$/.test(codes[0])) return null;
    return String(value).replace(/(https:\/\/[^/?#]+)\/ldcp\/coupon(?=\/?(?:[?#]|$))/, "$1/ldcp/login");
  } catch { return null; }
}
