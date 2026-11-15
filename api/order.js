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
        return { success: false, message: 'API Key Digiflazz belum dipasang di Vercel' };
    }

    const sign = crypto
        .createHash('md5')
        .update(`${digiUsername}${digiApiKey}${order.invoiceId}`)
        .digest('hex');

    const response = await fetch('https://api.digiflazz.com/v1/transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: digiUsername,
            buyer_sku_code: order.sku,
            customer_no: order.customerNo,
            ref_id: order.invoiceId,
            sign: sign
        })
    });

    return await response.json();
}

export default async function handler(req, res) {
    const action = req.query.action;
    const adminPassword = process.env.ADMIN_PASSWORD || 'sean123';

    // 1. CEK STATUS PEMBAYARAN OLEH PEMBELI
    if (action === 'status') {
        const { invoiceId } = req.query;
        const order = Object.values(global.pendingOrders).find(o => o.invoiceId === invoiceId);
        if (!order) return res.status(200).json({ status: 'NOT_FOUND' });
        return res.status(200).json({ status: order.status, digiflazz: order.digiflazzResult || null });
    }

    // 2. DAFTAR PESANAN UNTUK HALAMAN ADMIN
    if (action === 'list') {
        if (req.query.password !== adminPassword) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        const orders = Object.values(global.pendingOrders).sort((a, b) => b.createdAt - a.createdAt);
        return res.status(200).json({ success: true, orders });
    }

    // 3. APPROVE MANUAL DARI HALAMAN ADMIN
    if (action === 'approve' && req.method === 'POST') {
        const { password, totalPrice } = req.body;
        if (password !== adminPassword) {
            return res.status(401).json({ success: false, message: 'Password Admin salah!' });
        }
        const order = global.pendingOrders[totalPrice];
        if (!order) return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });

        order.status = 'PAID';
        const digiResult = await processDigiflazz(order);
        order.digiflazzResult = digiResult;
        return res.status(200).json({
            success: true,
            message: `Pesanan ${order.invoiceId} disetujui & dikirim ke Digiflazz!`,
            digiflazz: digiResult
        });
    }

    // 4. WEBHOOK OTOMATIS DARI NOTIFIKASI HP ANDROID (GOPAY MERCHANT)
    if (action === 'mutasi') {
        const secret = req.query.secret || req.body?.secret;
        const expectedSecret = process.env.WEBHOOK_SECRET || 'SEAN123';

        if (secret !== expectedSecret) {
            return res.status(403).json({ success: false, message: 'Secret Key salah!' });
        }

        const rawNotif = req.query.text || req.body?.text || JSON.stringify(req.body || '');
        const cleanNotif = rawNotif.replace(/,00\b/g, '').replace(/[.,]/g, '');

        const matchedOrder = Object.values(global.pendingOrders).find(
            o => o.status === 'PENDING' && cleanNotif.includes(String(o.totalPrice))
        );

        if (!matchedOrder) {
            return res.status(200).json({ success: false, message: 'Tidak ada pesanan pending dengan nominal tersebut' });
        }

        matchedOrder.status = 'PAID';
        const digiResult = await processDigiflazz(matchedOrder);
        matchedOrder.digiflazzResult = digiResult;

        return res.status(200).json({
            success: true,
            message: `Pembayaran ${matchedOrder.invoiceId} Lunas & Digiflazz Diproses!`,
            digiflazz: digiResult
        });
    }

    // 5. BUAT PESANAN BARU & QRIS DINAMIS GOPAY MERCHANT
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const { userId, zoneId, nickname, item, sku, price, paymentMethod, whatsapp } = req.body;
    const randomNum = Math.floor(100000 + Math.random() * 900000);
    const invoiceId = `SEAN-${randomNum}`;
    const uniqueCode = Math.floor(11 + Math.random() * 89);
    const totalPrice = parseInt(price) + uniqueCode;
    const customerNo = `${userId}${zoneId}`;

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

    global.pendingOrders[totalPrice] = {
        invoiceId, userId, zoneId, customerNo, nickname, item, sku, totalPrice, whatsapp,
        status: 'PENDING',
        createdAt: Date.now()
    };

    return res.status(200).json({
        success: true, invoiceId, nickname, item, sku, paymentMethod, totalPrice, uniqueCode, qrImage
    });
}