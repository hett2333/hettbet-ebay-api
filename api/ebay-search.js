const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

const EBAY_AUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getEbayAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error('Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET environment variables.');
  }

  const basicAuth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(EBAY_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`eBay auth failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 120) * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return;
  }

  try {
    const { q, listingType, limit } = req.query;

    if (!q || !q.trim()) {
      res.status(400).json({ error: 'Missing required query parameter: q' });
      return;
    }

    const token = await getEbayAccessToken();

    const params = new URLSearchParams({
      q: q,
      limit: limit || '25'
    });

    if (listingType === 'fixed') {
      params.set('filter', 'buyingOptions:{FIXED_PRICE}');
    } else if (listingType === 'auction') {
      params.set('filter', 'buyingOptions:{AUCTION}');
    }

    const ebayResponse = await fetch(`${EBAY_BROWSE_URL}?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
      }
    });

    if (!ebayResponse.ok) {
      const errText = await ebayResponse.text();
      res.status(ebayResponse.status).json({ error: `eBay API error: ${errText}` });
      return;
    }

    const data = await ebayResponse.json();

    const items = (data.itemSummaries || []).map(item => ({
      card: item.title,
      platform: 'eBay',
      price: item.price ? parseFloat(item.price.value) : null,
      currency: item.price ? item.price.currency : null,
      listing_type: (item.buyingOptions || []).includes('AUCTION') ? 'Auction' : 'Fixed Price',
      condition: item.condition || null,
      image: item.image ? item.image.imageUrl : null,
      url: item.itemWebUrl || null,
      seller: item.seller ? item.seller.username : null,
      current_bid_count: item.bidCount != null ? item.bidCount : null,
      auction_end_time: item.itemEndDate || null
    }));

    res.status(200).json({
      total: data.total || items.length,
      items
    });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message || 'Unknown server error' });
  }
}
