import crypto from 'crypto';

global.pendingOrders = global.pendingOrders || {};

function convertCRC16(str) {
    let crc = 0xFFFF;
    for (let c = 0; c < str.length; c++) {
        crc ^= str.charCodeAt(c) << 8;
        for (let i = 0; i < 8; i++) {
            if (crc & 0x8000) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function generateDynamicQRIS(staticQris, amount) {
    const qrisClean = staticQris.trim();
    const qrisWithoutCrc = qrisClean.slice(0, -4);
    const step1 = qrisWithoutCrc.replace('010211', '010212');
    const parts = step1.split('5802ID');
    if (parts.length < 2) {
        throw new Error('Format kode QRIS Statis GoPay Merchant tidak valid!');
    }
    const amountStr = String(amount);
    const amountTag = '54' + String(amountStr.length).padStart(2, '0') + amountStr;
    const payload = parts[0] + amountTag + '5802ID' + parts[1];
    return payload + convertCRC16(payload);
}

async function processDigiflazz(order) {
    const digiUsername = process.env.DIGIFLAZZ_USERNAME;
    const digiApiKey = process.env.DIGIFLAZZ_API_KEY;

    if (!digiUsername || !digiApiKey) {
        return { success: false, status: 'ERROR', message: 'API Key Digiflazz belum dipasang di Vercel' };
    }

    const sign = crypto
        .createHash('md5')
        .update(`${digiUsername}${digiApiKey}${order.invoiceId}`)
        .digest('hex');

    let payload;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        let response;
        try {
            response = await fetch('https://api.digiflazz.com/v1/transaction', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: digiUsername,
                    buyer_sku_code: order.sku,
                    customer_no: order.customerNo,
                    ref_id: order.invoiceId,
                    sign: sign
                }),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }
        payload = await response.json();
    } catch (e) {
        return { success: false, status: 'ERROR', message: 'Tidak bisa menghubungi Digiflazz (jaringan/waktu habis). Coba kirim ulang.' };
    }

    // Bentuk jawaban Digiflazz: { data: { status: Sukses|Gagal|Pending, message, rc, sn } }.
    // Sukses/Pending = permintaan diterima. Gagal = ditolak (SKU/saldo/format).
    const data = (payload && payload.data) || {};
    const digiStatus = data.status || '';
    const accepted = digiStatus === 'Sukses' || digiStatus === 'Pending';
    return {
        success: accepted,
        status: digiStatus || 'ERROR',
        message: data.message || 'Digiflazz tidak memberi keterangan.',
        rc: data.rc || null,
        sn: data.sn || null
    };
}

function normalizeWa(input) {
    const digits = String(input || '').replace(/\D/g, '');
    if (digits.startsWith('0')) return '62' + digits.slice(1);
    return digits;
}

function escTg(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatRp(n) {
    return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
}

// Kirim notifikasi ke Bot Telegram Admin (best-effort, tidak pernah memblokir transaksi)
async function notifyTelegram(htmlText) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const rawIds = process.env.TELEGRAM_CHAT_ID || '';
    const chatIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);
    if (!token || chatIds.length === 0) return;

    await Promise.all(chatIds.map(async (chatId) => {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4000);
            try {
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: htmlText,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    }),
                    signal: ctrl.signal
                });
            } finally {
                clearTimeout(t);
            }
        } catch (e) {}
    }));
}

// URL Firebase dengan Database Secret (?auth=).
// Secret HANYA dibaca dari environment variable FIREBASE_DB_SECRET di Vercel.
// Jangan pernah menulis secret di file kode atau commit ke GitHub.
// Kalau secret belum dipasang, URL tanpa auth dipakai (masa transisi saat
// rules masih terbuka). Setelah rules dikunci, secret WAJIB terpasang.
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

// Simpan order ke Firebase agar muncul di riwayat pesanan customer & admin (permanen, anti cold-start).
async function saveOrderToFirebase(order) {
    try {
        if (!order.invoiceId) return false;
        const url = firebaseUrl(`/orders/${encodeURIComponent(order.invoiceId)}`);
        if (!url) return false;
        const r = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(order)
        });
        return r.ok;
    } catch (e) { return false; }
}

async function updateOrderStatusInFirebase(invoiceId, status, extras) {
    try {
        if (!invoiceId) return false;
        const url = firebaseUrl(`/orders/${encodeURIComponent(invoiceId)}`);
        if (!url) return false;
        const r = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: status, paidAt: Date.now(), ...(extras || {}) })
        });
        return r.ok;
    } catch (e) { return false; }
}

async function getOrderFromFirebase(invoiceId) {
    try {
        if (!invoiceId) return null;
        const url = firebaseUrl(`/orders/${encodeURIComponent(invoiceId)}`);
        if (!url) return null;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return null;
        const data = await r.json();
        return data && data.invoiceId ? data : null;
    } catch (e) { return null; }
}

async function getAllOrdersFromFirebase() {
    try {
        const url = firebaseUrl('/orders');
        if (!url) return null;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return null;
        const data = await r.json();
        if (!data || typeof data !== 'object') return [];
        return Object.values(data).filter(o => o && o.invoiceId);
    } catch (e) { return null; }
}

async function getProductsFromFirebase() {
    try {
        const url = firebaseUrl('/products');
        if (!url) return null;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return null;
        const data = await r.json();
        return Array.isArray(data) && data.length > 0 ? data : null;
    } catch (e) { return null; }
}

function mergeOrders(memMap, fbList) {
    const byId = new Map();
    if (Array.isArray(fbList)) {
        fbList.forEach(o => { if (o && o.invoiceId) byId.set(o.invoiceId, o); });
    }
    Object.values(memMap || {}).forEach(o => {
        if (!o || !o.invoiceId) return;
        const existing = byId.get(o.invoiceId);
        if (!existing || (o.status === 'PAID' && existing.status !== 'PAID')) {
            byId.set(o.invoiceId, o);
        }
    });
    return Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export default async function handler(req, res) {
    const action = req.query.action;
    // Tanpa ADMIN_PASSWORD di Vercel, semua akses admin ditolak (fail-closed).
    // Tidak ada lagi password default di kode.
    const adminPassword = process.env.ADMIN_PASSWORD;

    // 1. CEK STATUS PEMBAYARAN OLEH PEMBELI (Baca dari Firebase agar kebal cold-start)
    if (action === 'status') {
        const { invoiceId } = req.query;
        if (!invoiceId) return res.status(200).json({ status: 'NOT_FOUND' });
        let order = await getOrderFromFirebase(invoiceId);
        if (!order) {
            order = Object.values(global.pendingOrders).find(o => o && o.invoiceId === invoiceId) || null;
        }
        if (!order) return res.status(200).json({ status: 'NOT_FOUND' });
        return res.status(200).json({ status: order.status, digiflazz: order.digiflazzResult || null });
    }

    // 2. DAFTAR PESANAN UNTUK HALAMAN ADMIN (Baca permanen dari Firebase + gabung memori lokal)
    if (action === 'list') {
        const supplied = (req.body && req.body.password) || req.query.password;
        if (!adminPassword || supplied !== adminPassword) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        const fbOrders = await getAllOrdersFromFirebase();
        const orders = mergeOrders(global.pendingOrders, fbOrders).slice(0, 100);
        return res.status(200).json({ success: true, orders });
    }

    // 3. APPROVE MANUAL / KIRIM ULANG DIGIFLAZZ DARI HALAMAN ADMIN (Cari by invoiceId atau totalPrice di Firebase)
    if (action === 'approve' && req.method === 'POST') {
        const { password, invoiceId, totalPrice } = req.body;
        if (!adminPassword || password !== adminPassword) {
            return res.status(401).json({ success: false, message: 'Password Admin salah!' });
        }

        let order = null;
        if (invoiceId) {
            order = await getOrderFromFirebase(invoiceId);
            if (!order) {
                order = Object.values(global.pendingOrders).find(o => o && o.invoiceId === invoiceId) || null;
            }
        }
        if (!order && totalPrice != null) {
            order = global.pendingOrders[totalPrice] || null;
            if (!order) {
                const fbOrders = await getAllOrdersFromFirebase();
                if (Array.isArray(fbOrders)) {
                    order = fbOrders
                        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                        .find(o => Number(o.totalPrice) === Number(totalPrice)) || null;
                }
            }
        }
        if (!order) return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });

        order.status = 'PAID';
        const digiResult = await processDigiflazz(order);
        order.digiflazzResult = digiResult;
        order.deliveryStatus = digiResult.success ? 'SENT' : 'FAILED';
        order.digiflazzMessage = digiResult.message;
        global.pendingOrders[order.invoiceId] = order;

        await updateOrderStatusInFirebase(order.invoiceId, 'PAID', {
            deliveryStatus: order.deliveryStatus,
            digiflazzMessage: order.digiflazzMessage,
            digiflazzResult: digiResult
        });

        await notifyTelegram(
            `${digiResult.success ? '✅' : '❌'} <b>Approve Manual Admin — ${escTg(order.invoiceId)}</b>\n\n` +
            `• Item: <b>${escTg(order.item)}</b> (<code>${escTg(order.sku)}</code>)\n` +
            `• Akun: ${escTg(order.nickname || '-')} (<code>${escTg(order.userId)}</code> / <code>${escTg(order.zoneId)}</code>)\n` +
            `• Total: <b>${formatRp(order.totalPrice)}</b>\n` +
            `• Digiflazz: <b>${escTg(digiResult.status)}</b> — ${escTg(digiResult.message)}` +
            (digiResult.sn ? `\n• SN: <code>${escTg(digiResult.sn)}</code>` : '')
        );

        return res.status(200).json({
            success: digiResult.success,
            message: digiResult.success
                ? `Pesanan ${order.invoiceId} disetujui & dikirim ke Digiflazz!`
                : `Pembayaran ${order.invoiceId} LUNAS, tapi Digiflazz GAGAL (${digiResult.message}). Perbaiki penyebabnya, lalu tekan Kirim Ulang.`,
            digiflazz: digiResult
        });
    }

    // 4. WEBHOOK OTOMATIS DARI NOTIFIKASI HP ANDROID (GOPAY MERCHANT)
    if (action === 'mutasi') {
        const secret = req.query.secret || req.body?.secret;
        const expectedSecret = process.env.WEBHOOK_SECRET;

        if (!expectedSecret || secret !== expectedSecret) {
            return res.status(403).json({ success: false, message: 'Secret Key salah!' });
        }

        const rawNotif = req.query.text || req.body?.text || JSON.stringify(req.body || '');
        const cleanNotif = rawNotif.replace(/,00\b/g, '').replace(/[.,]/g, '');

        // Cari pesanan PENDING terbaru dari Firebase + memori (kebal cold-start Vercel)
        const fbOrders = await getAllOrdersFromFirebase();
        const allOrders = mergeOrders(global.pendingOrders, fbOrders);
        const matchedOrder = allOrders.find(
            o => o.status === 'PENDING' && o.totalPrice && cleanNotif.includes(String(o.totalPrice))
        );

        if (!matchedOrder) {
            return res.status(200).json({ success: false, message: 'Tidak ada pesanan pending dengan nominal tersebut' });
        }

        matchedOrder.status = 'PAID';
        const digiResult = await processDigiflazz(matchedOrder);
        matchedOrder.digiflazzResult = digiResult;
        matchedOrder.deliveryStatus = digiResult.success ? 'SENT' : 'FAILED';
        matchedOrder.digiflazzMessage = digiResult.message;
        global.pendingOrders[matchedOrder.invoiceId] = matchedOrder;

        await updateOrderStatusInFirebase(matchedOrder.invoiceId, 'PAID', {
            deliveryStatus: matchedOrder.deliveryStatus,
            digiflazzMessage: matchedOrder.digiflazzMessage,
            digiflazzResult: digiResult
        });

        await notifyTelegram(
            `${digiResult.success ? '💰✅' : '💰❌'} <b>Pembayaran QRIS Masuk (Auto) — ${escTg(matchedOrder.invoiceId)}</b>\n\n` +
            `• Item: <b>${escTg(matchedOrder.item)}</b> (<code>${escTg(matchedOrder.sku)}</code>)\n` +
            `• Akun: ${escTg(matchedOrder.nickname || '-')} (<code>${escTg(matchedOrder.userId)}</code> / <code>${escTg(matchedOrder.zoneId)}</code>)\n` +
            `• Total Bayar: <b>${formatRp(matchedOrder.totalPrice)}</b>\n` +
            `• WA Pembeli: ${escTg(matchedOrder.whatsapp || '-')}\n` +
            `• Digiflazz: <b>${escTg(digiResult.status)}</b> — ${escTg(digiResult.message)}` +
            (digiResult.sn ? `\n• SN: <code>${escTg(digiResult.sn)}</code>` : '') +
            (!digiResult.success ? `\n\n👉 Kirim ulang via bot: <code>/kirim ${escTg(matchedOrder.invoiceId)}</code>` : '')
        );

        return res.status(200).json({
            success: digiResult.success,
            message: digiResult.success
                ? `Pembayaran ${matchedOrder.invoiceId} Lunas & Digiflazz Diproses!`
                : `Pembayaran ${matchedOrder.invoiceId} Lunas, tapi Digiflazz GAGAL (${digiResult.message}).`,
            digiflazz: digiResult
        });
    }

    // 5. BUAT PESANAN BARU & QRIS DINAMIS GOPAY MERCHANT
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const { userId, zoneId, nickname, item, sku, price, paymentMethod, whatsapp } = req.body;
    if (!userId || !zoneId || !sku) {
        return res.status(400).json({ success: false, message: 'Data akun dan produk wajib diisi!' });
    }

    // Validasi harga asli dari Firebase /products di sisi server (anti manipulasi harga dari browser!)
    const fbProducts = await getProductsFromFirebase();
    let verifiedPrice = parseInt(price, 10);
    let verifiedItem = item;
    const skuNorm = String(sku).trim().toUpperCase();

    if (fbProducts) {
        const matchedProd = fbProducts.find(p => p && String(p.sku || '').trim().toUpperCase() === skuNorm);
        if (!matchedProd) {
            return res.status(400).json({ success: false, message: 'Produk / SKU tidak valid atau sudah tidak tersedia.' });
        }
        verifiedPrice = parseInt(matchedProd.price, 10);
        verifiedItem = matchedProd.name || item;
    }

    if (!Number.isFinite(verifiedPrice) || verifiedPrice < 500) {
        return res.status(400).json({ success: false, message: 'Harga produk tidak valid.' });
    }

    // Cegah tabrakan nominal unik dengan pesanan PENDING aktif dalam 3 jam terakhir
    const fbOrders = await getAllOrdersFromFirebase();
    const recentOrders = mergeOrders(global.pendingOrders, fbOrders);
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const activePendingTotals = new Set(
        recentOrders
            .filter(o => o.status === 'PENDING' && (o.createdAt || 0) >= threeHoursAgo)
            .map(o => Number(o.totalPrice))
    );

    let uniqueCode = Math.floor(11 + Math.random() * 89);
    for (let attempt = 0; attempt < 30; attempt++) {
        if (!activePendingTotals.has(verifiedPrice + uniqueCode)) break;
        uniqueCode = Math.floor(11 + Math.random() * 189);
    }

    const randomNum = Math.floor(100000 + Math.random() * 900000);
    const invoiceId = `SEAN-${randomNum}`;
    const totalPrice = verifiedPrice + uniqueCode;
    const customerNo = `${String(userId).trim()}${String(zoneId).trim()}`;

    const staticQris = process.env.GOPAY_QRIS_STATIC;
    let qrDataString = `SEANTOPUP|${invoiceId}|${totalPrice}`;

    try {
        if (staticQris && staticQris.length > 50) {
            qrDataString = generateDynamicQRIS(staticQris, totalPrice);
        }
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }

    const qrImage = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&margin=10&data=${encodeURIComponent(qrDataString)}`;

    const newOrder = {
        invoiceId, userId: String(userId).trim(), zoneId: String(zoneId).trim(),
        customerNo, nickname, item: verifiedItem, sku: skuNorm, totalPrice, whatsapp,
        price: verifiedPrice, uniqueCode, paymentMethod, qrImage, wa: normalizeWa(whatsapp),
        status: 'PENDING',
        createdAt: Date.now()
    };

    global.pendingOrders[invoiceId] = newOrder;

    // Simpan ke Firebase agar muncul di riwayat pesanan customer & admin (permanen).
    await saveOrderToFirebase(newOrder);

    await notifyTelegram(
        `🆕 <b>Pesanan Baru Masuk (PENDING)</b>\n\n` +
        `• Invoice: <code>${escTg(invoiceId)}</code>\n` +
        `• Item: <b>${escTg(verifiedItem)}</b> (<code>${escTg(skuNorm)}</code>)\n` +
        `• Akun MLBB: ${escTg(nickname || '-')} (<code>${escTg(newOrder.userId)}</code> / <code>${escTg(newOrder.zoneId)}</code>)\n` +
        `• Total Unik: <b>${formatRp(totalPrice)}</b> (Kode Unik: +${uniqueCode})\n` +
        `• WA Pembeli: ${escTg(whatsapp || '-')}\n\n` +
        `⏳ Menunggu pembayaran QRIS...\n` +
        `👉 Approve manual: <code>/kirim ${escTg(invoiceId)}</code>`
    );

    return res.status(200).json({
        success: true, invoiceId, nickname, item: verifiedItem, sku: skuNorm,
        paymentMethod, totalPrice, uniqueCode, qrImage
    });
}
