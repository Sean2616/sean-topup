import crypto from 'crypto';

// =========================================================================
// Monitor Gangguan Produk / Seller Trouble Digiflazz -> Alert Bot Telegram
// -------------------------------------------------------------------------
// Mengecek semua SKU website (/products di Firebase) terhadap katalog live
// Digiflazz. Anti-spam: hanya mengirim notifikasi Telegram saat status SKU
// BERUBAH (Normal -> Gangguan/Seller Trouble/Modal Rugi, atau Pulih -> Normal).
//
// Cara memanggil (bisa dipasang di cron-job.org tiap 5-10 menit gratis):
//   GET https://topup.disean.my.id/api/monitor-digiflazz?secret=WEBHOOK_SECRET
//
// Tambahkan &force=1 jika ingin memaksa kirim laporan gangguan saat ini
// walaupun status belum berubah.
// =========================================================================

function formatRp(num) {
    return 'Rp ' + Number(num || 0).toLocaleString('id-ID');
}

function escTg(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function firebaseUrl(path) {
    const base = process.env.FIREBASE_DB_URL
        ? process.env.FIREBASE_DB_URL.replace(/\/$/, '')
        : null;
    if (!base) return null;
    const secret = process.env.FIREBASE_DB_SECRET;
    return secret
        ? `${base}${path}.json?auth=${encodeURIComponent(secret)}`
        : `${base}${path}.json`;
}

async function fetchFirebase(path) {
    const url = firebaseUrl(path);
    if (!url) return null;
    try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return null;
        return await r.json();
    } catch (e) { return null; }
}

async function saveFirebase(path, data) {
    const url = firebaseUrl(path);
    if (!url) return false;
    try {
        const r = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return r.ok;
    } catch (e) { return false; }
}

async function notifyTelegram(htmlText) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const rawIds = process.env.TELEGRAM_CHAT_ID || '';
    const chatIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);
    if (!token || chatIds.length === 0) return false;

    let sent = false;
    await Promise.all(chatIds.map(async (chatId) => {
        try {
            const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: htmlText,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            });
            if (r.ok) sent = true;
        } catch (e) {}
    }));
    return sent;
}

function classifyProduct(webProd, digiItem) {
    const sku = String(webProd.sku || '').trim().toUpperCase();
    const sellPrice = Number(webProd.price || 0);

    if (!digiItem) {
        return {
            sku,
            name: webProd.name,
            state: 'MISSING',
            reason: 'SKU tidak ditemukan di katalog Digiflazz',
            buyPrice: null,
            sellPrice
        };
    }

    const buyPrice = Number(digiItem.price || 0);
    const sellerOk = digiItem.seller_product_status === true;
    const buyerOk = digiItem.buyer_product_status === true;

    if (!sellerOk) {
        const cutOff = digiItem.start_cut_off && digiItem.end_cut_off
            ? ` (Cut-off: ${digiItem.start_cut_off}–${digiItem.end_cut_off})`
            : '';
        return {
            sku,
            name: webProd.name,
            state: 'SELLER_TROUBLE',
            reason: `Seller gangguan / tutup / stok kosong${cutOff}`,
            buyPrice,
            sellPrice
        };
    }

    if (!buyerOk) {
        return {
            sku,
            name: webProd.name,
            state: 'BUYER_INACTIVE',
            reason: 'Produk nonaktif di pengaturan Buyer Digiflazz',
            buyPrice,
            sellPrice
        };
    }

    if (buyPrice > sellPrice) {
        return {
            sku,
            name: webProd.name,
            state: 'PRICE_LOSS',
            reason: `Harga modal naik (${formatRp(buyPrice)}) melebihi harga jual (${formatRp(sellPrice)})`,
            buyPrice,
            sellPrice
        };
    }

    return {
        sku,
        name: webProd.name,
        state: 'OK',
        reason: 'Aktif & Normal',
        buyPrice,
        sellPrice
    };
}

export default async function handler(req, res) {
    // Izinkan Vercel Cron (header x-vercel-cron) atau pemanggilan dengan ?secret=WEBHOOK_SECRET
    const isVercelCron = Boolean(req.headers['x-vercel-cron']);
    const expectedSecret = process.env.WEBHOOK_SECRET || process.env.ADMIN_PASSWORD;
    const suppliedSecret = req.query.secret || (req.body && req.body.secret);

    if (!isVercelCron && (!expectedSecret || suppliedSecret !== expectedSecret)) {
        return res.status(403).json({ ok: false, message: 'Secret tidak valid. Gunakan ?secret=WEBHOOK_SECRET' });
    }

    const username = process.env.DIGIFLAZZ_USERNAME;
    const apiKey = process.env.DIGIFLAZZ_API_KEY;
    if (!username || !apiKey) {
        return res.status(500).json({ ok: false, message: 'DIGIFLAZZ_USERNAME / DIGIFLAZZ_API_KEY belum dipasang di Vercel.' });
    }

    const webProducts = await fetchFirebase('/products');
    if (!Array.isArray(webProducts) || webProducts.length === 0) {
        return res.status(200).json({ ok: true, message: 'Daftar produk di Firebase kosong.' });
    }

    // Ambil katalog Digiflazz dengan Cache 15 menit di Firebase agar tidak kena rate-limit Digiflazz
    const CACHE_TTL_MS = 15 * 60 * 1000;
    const forceRefresh = req.query.refresh === '1';
    const cached = await fetchFirebase('/digiflazz_catalog_cache');
    const cacheFresh = cached && Array.isArray(cached.items) && cached.items.length > 0 && (Date.now() - (cached.updatedAt || 0) < CACHE_TTL_MS);

    let catalog = null;
    let fromCache = false;
    let cacheAgeMin = 0;

    if (!forceRefresh && cacheFresh) {
        catalog = cached.items;
        fromCache = true;
        cacheAgeMin = Math.round((Date.now() - cached.updatedAt) / 60000);
    } else {
        const sign = crypto.createHash('md5').update(`${username}${apiKey}pricelist`).digest('hex');
        let apiErr = null;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 9000);
            try {
                const r = await fetch('https://api.digiflazz.com/v1/price-list', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cmd: 'prepaid', username, sign }),
                    signal: ctrl.signal
                });
                const j = await r.json();
                if (j && Array.isArray(j.data)) {
                    // Simpan hanya field penting agar ringan di Firebase
                    catalog = j.data.map(item => ({
                        buyer_sku_code: item.buyer_sku_code,
                        product_name: item.product_name,
                        brand: item.brand,
                        category: item.category,
                        price: item.price,
                        buyer_product_status: item.buyer_product_status,
                        seller_product_status: item.seller_product_status,
                        start_cut_off: item.start_cut_off || '',
                        end_cut_off: item.end_cut_off || ''
                    }));
                    await saveFirebase('/digiflazz_catalog_cache', {
                        updatedAt: Date.now(),
                        items: catalog
                    });
                } else {
                    apiErr = (j && j.data && j.data.message) || 'Digiflazz menolak permintaan pricelist.';
                }
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            apiErr = 'Gagal menghubungi API Digiflazz: ' + e.message;
        }

        // Jika terkena rate-limit / error tapi ada cache lama, fallback pakai cache terakhir!
        if (!catalog) {
            if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
                catalog = cached.items;
                fromCache = true;
                cacheAgeMin = Math.round((Date.now() - (cached.updatedAt || Date.now())) / 60000);
            } else {
                return res.status(200).json({ ok: false, rateLimited: true, message: apiErr });
            }
        }
    }

    const bySku = new Map();
    catalog.forEach(item => {
        if (item && item.buyer_sku_code) {
            bySku.set(String(item.buyer_sku_code).toUpperCase(), item);
        }
    });

    // Status sebelumnya dari Firebase (untuk mencegah spam)
    const prevStateObj = (await fetchFirebase('/digiflazz_monitor/states')) || {};
    const nextStateObj = {};

    const newlyBroken = [];
    const newlyRecovered = [];
    const allBroken = [];

    for (const wp of webProducts) {
        const sku = String(wp.sku || '').trim().toUpperCase();
        if (!sku) continue;
        const result = classifyProduct(wp, bySku.get(sku));
        const prev = prevStateObj[sku] || 'OK';
        nextStateObj[sku] = result.state;

        if (result.state !== 'OK') {
            allBroken.push(result);
            if (prev === 'OK' || prev !== result.state) {
                newlyBroken.push(result);
            }
        } else if (prev !== 'OK') {
            newlyRecovered.push(result);
        }
    }

    // Simpan snapshot status terbaru ke Firebase
    await saveFirebase('/digiflazz_monitor', {
        checkedAt: Date.now(),
        totalChecked: webProducts.length,
        brokenCount: allBroken.length,
        states: nextStateObj
    });

    const force = req.query.force === '1';
    const messagesSent = [];

    // 1. Kirim Alert jika ada produk yang baru saja bermasalah (atau dipaksa via ?force=1)
    const toAlert = force ? allBroken : newlyBroken;
    if (toAlert.length > 0) {
        const lines = toAlert.map(item =>
            `• <code>${escTg(item.sku)}</code> — <b>${escTg(item.name)}</b>\n  └ ⚠️ ${escTg(item.reason)}`
        );
        const alertText = [
            `🚨 <b>ALERT PRODUK BERMASALAH (DIGIFLAZZ)</b>`,
            ``,
            ...lines,
            ``,
            `📊 Total bermasalah saat ini: <b>${allBroken.length}/${webProducts.length}</b> produk.`,
            `👉 Ketik <code>/gangguan</code> kapan saja untuk cek ulang.`
        ].join('\n');
        await notifyTelegram(alertText);
        messagesSent.push('ALERT_BROKEN');
    }

    // 2. Kirim info jika ada produk yang tadinya gangguan lalu sekarang PULIH
    if (newlyRecovered.length > 0) {
        const lines = newlyRecovered.map(item =>
            `• <code>${escTg(item.sku)}</code> — <b>${escTg(item.name)}</b> (Modal: ${formatRp(item.buyPrice)} | Jual: ${formatRp(item.sellPrice)})`
        );
        const recoverText = [
            `✅ <b>PRODUK DIGIFLAZZ PULIH KEMBALI</b>`,
            ``,
            ...lines,
            ``,
            `Produk di atas sudah aktif normal kembali di seller Digiflazz.`
        ].join('\n');
        await notifyTelegram(recoverText);
        messagesSent.push('RECOVERED');
    }

    return res.status(200).json({
        ok: true,
        fromCache,
        cacheAgeMinutes: cacheAgeMin,
        checked: webProducts.length,
        brokenCount: allBroken.length,
        newlyBrokenCount: newlyBroken.length,
        newlyRecoveredCount: newlyRecovered.length,
        notified: messagesSent,
        broken: allBroken
    });
}
