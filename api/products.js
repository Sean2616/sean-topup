// Daftar Produk Awal jika Firebase masih kosong
const defaultProducts = [
    { id: 1, name: 'Weekly Diamond Pass', price: 27500, sku: 'WDP', category: 'special', badge: 'Paling Laris!' },
    { id: 2, name: '5 Diamonds', price: 1500, sku: 'ML5', category: 'diamond', badge: '' },
    { id: 3, name: '86 Diamonds', price: 20500, sku: 'ML86', category: 'diamond', badge: '' },
    { id: 4, name: '172 Diamonds', price: 41000, sku: 'ML172', category: 'diamond', badge: '' },
    { id: 5, name: '257 Diamonds', price: 61500, sku: 'ML257', category: 'diamond', badge: '' },
    { id: 6, name: '706 Diamonds', price: 165000, sku: 'ML706', category: 'diamond', badge: '' },
    { id: 7, name: '2195 Diamonds', price: 495000, sku: 'ML2195', category: 'diamond', badge: '' }
];

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
    // Tanpa ADMIN_PASSWORD di Vercel, semua akses admin ditolak (fail-closed).
    // Tidak ada lagi password default di kode.
    const adminPassword = process.env.ADMIN_PASSWORD;
    // Ambil URL Firebase dan hapus garis miring di ujung jika ada
    const url = firebaseUrl('/products');

    // 1. GET: Diambil oleh Halaman Pembeli (index.html) & Halaman Admin
    if (req.method === 'GET') {
        if (!url) {
            return res.status(200).json({
                success: true,
                products: defaultProducts,
                warning: 'FIREBASE_DB_URL belum dipasang di Vercel'
            });
        }

        try {
            const response = await fetch(url, { cache: 'no-store' });
            const data = await response.json();

            // Jika di Firebase sudah ada pricelist, tampilkan ke pembeli!
            if (data && Array.isArray(data) && data.length > 0) {
                return res.status(200).json({ success: true, products: data });
            }

            // Jika Firebase masih kosong, isi otomatis dengan defaultProducts
            await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(defaultProducts)
            });

            return res.status(200).json({ success: true, products: defaultProducts });
        } catch (error) {
            return res.status(200).json({ success: true, products: defaultProducts });
        }
    }

    // 2. POST: Menyimpan Perubahan Harga dari Admin ke Firebase
    if (req.method === 'POST') {
        const { password, action, products } = req.body;

        if (!adminPassword || password !== adminPassword) {
            return res.status(401).json({ success: false, message: 'Password Admin salah!' });
        }

        if (action === 'login') {
            return res.status(200).json({ success: true, message: 'Login berhasil' });
        }

        if (!url) {
            return res.status(500).json({
                success: false,
                message: 'FIREBASE_DB_URL belum dipasang di Environment Variables Vercel!'
            });
        }

        if (Array.isArray(products)) {
            try {
                const saveRes = await fetch(url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(products)
                });

                if (!saveRes.ok) {
                    throw new Error('Periksa FIREBASE_DB_URL dan FIREBASE_DB_SECRET di Vercel (secret wajib ada setelah rules dikunci).');
                }

                return res.status(200).json({
                    success: true,
                    products,
                    message: 'Pricelist berhasil disimpan permanen ke Firebase!'
                });
            } catch (error) {
                return res.status(500).json({
                    success: false,
                    message: 'Gagal menyimpan ke Firebase: ' + error.message
                });
            }
        }

        return res.status(400).json({ success: false, message: 'Data produk tidak valid' });
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
}
