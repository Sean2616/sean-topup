import crypto from 'crypto';

// Tes koneksi Digiflazz (READ-ONLY): hanya membaca katalog harga prepaid,
// TIDAK membuat transaksi dan TIDAK memotong saldo. Dipanggil dari panel
// admin untuk menjawab: kredensial terpasang? API terjangkau? SKU valid?
// Kredensial TIDAK PERNAH dikembalikan ke browser (hanya status terpasang).
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    // Tanpa ADMIN_PASSWORD di Vercel, akses ditolak (fail-closed).
    // Tidak ada lagi password default di kode.
    const adminPassword = process.env.ADMIN_PASSWORD;
    const { password, skus } = req.body || {};
    if (!adminPassword || password !== adminPassword) {
        return res.status(401).json({ success: false, message: 'Password Admin salah!' });
    }

    const username = process.env.DIGIFLAZZ_USERNAME || '';
    const apiKey = process.env.DIGIFLAZZ_API_KEY || '';
    const env = { usernameSet: Boolean(username), apiKeySet: Boolean(apiKey) };
    if (!env.usernameSet || !env.apiKeySet) {
        return res.status(200).json({
            success: false,
            message: 'Kredensial Digiflazz belum dipasang di Vercel. Pasang DIGIFLAZZ_USERNAME dan DIGIFLAZZ_API_KEY, lalu redeploy.',
            env: env,
            api: null,
            skuResults: []
        });
    }

    // Rumus signature price-list Digiflazz: md5(username + apiKey + "pricelist")
    const sign = crypto.createHash('md5').update(`${username}${apiKey}pricelist`).digest('hex');

    let catalog;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        let response;
        try {
            response = await fetch('https://api.digiflazz.com/v1/price-list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cmd: 'prepaid', username: username, sign: sign }),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }
        const payload = await response.json();
        const data = payload && payload.data;
        if (Array.isArray(data)) {
            catalog = data;
        } else {
            return res.status(200).json({
                success: false,
                message: (data && data.message) || 'Digiflazz menolak permintaan katalog. Periksa username/API key.',
                env: env,
                api: {
                    reachable: true,
                    rc: (data && data.rc) || null,
                    message: (data && data.message) || null,
                    httpStatus: response.status
                },
                skuResults: []
            });
        }
    } catch (e) {
        return res.status(200).json({
            success: false,
            message: 'Tidak bisa menghubungi api.digiflazz.com. Periksa koneksi server dan IP whitelist ke support Digiflazz.',
            env: env,
            api: { reachable: false, error: (e && e.name) || 'fetch_error' },
            skuResults: []
        });
    }

    const wanted = Array.isArray(skus)
        ? [...new Set(skus.filter(s => typeof s === 'string').map(s => s.trim().toUpperCase()).filter(Boolean))].slice(0, 100)
        : [];
    const bySku = new Map();
    for (const item of catalog) {
        if (item && typeof item.buyer_sku_code === 'string') {
            const code = item.buyer_sku_code.toUpperCase();
            if (!bySku.has(code)) bySku.set(code, item);
        }
    }
    const skuResults = wanted.map(sku => {
        const item = bySku.get(sku);
        if (!item) return { sku: sku, found: false };
        return {
            sku: sku,
            found: true,
            productName: item.product_name || null,
            price: typeof item.price === 'number' ? item.price : null,
            buyerStatus: item.buyer_product_status ?? null,
            sellerStatus: item.seller_product_status ?? null,
            active: item.buyer_product_status === true && item.seller_product_status === true
        };
    });

    const missing = skuResults.filter(r => !r.found);
    return res.status(200).json({
        success: missing.length === 0,
        message: missing.length === 0
            ? 'Terhubung ke Digiflazz dan semua SKU ditemukan di katalog.'
            : `${missing.length} SKU tidak ditemukan di katalog Digiflazz. Perbaiki SKU-nya di panel admin.`,
        env: env,
        api: { reachable: true, totalProducts: catalog.length },
        skuResults: skuResults
    });
}
