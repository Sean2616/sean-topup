// Riwayat pesanan per customer, berdasarkan nomor WhatsApp.
// Membaca order yang disimpan di Firebase Realtime Database (/orders).
// Hanya order yang dibuat setelah fitur ini aktif yang muncul di riwayat.

function normalizeWa(input) {
    const digits = String(input || '').replace(/\D/g, '');
    if (digits.startsWith('0')) return '62' + digits.slice(1);
    return digits;
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

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const wa = normalizeWa(req.query.whatsapp);
    if (!/^62[0-9]{7,13}$/.test(wa)) {
        return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid. Gunakan nomor Indonesia (08xx atau 62xx).' });
    }

    const url = firebaseUrl('/orders');

    if (!url) {
        return res.status(500).json({ success: false, message: 'Riwayat belum tersedia (Firebase belum diatur).' });
    }

    try {
        const response = await fetch(url, { cache: 'no-store' });
        const data = await response.json();
        const all = data ? Object.values(data) : [];

        const mine = all
            .filter(o => o && (o.wa === wa || normalizeWa(o.whatsapp) === wa))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, 20)
            .map(o => ({
                invoiceId: o.invoiceId,
                createdAt: o.createdAt,
                nickname: o.nickname,
                userId: o.userId,
                zoneId: o.zoneId,
                item: o.item,
                sku: o.sku,
                price: o.price,
                uniqueCode: o.uniqueCode,
                totalPrice: o.totalPrice,
                paymentMethod: o.paymentMethod,
                status: o.status || 'PENDING',
                qrImage: o.qrImage || ''
            }));

        return res.status(200).json({ success: true, orders: mine });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal memuat riwayat. Silakan coba lagi.' });
    }
}
