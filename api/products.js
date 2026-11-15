import fs from 'fs';
import path from 'path';

const TMP_FILE = path.join('/tmp', 'sean_products.json');

// Daftar Produk & Harga Awal (Default)
const defaultProducts = [
    { id: 1, name: 'Weekly Diamond Pass', price: 27500, sku: 'WDP', category: 'special', badge: 'Paling Laris!' },
    { id: 2, name: 'Twilight Pass', price: 145000, sku: 'TWILIGHT', category: 'special', badge: '' },
    { id: 3, name: '5 Diamonds', price: 1500, sku: 'ML5', category: 'diamond', badge: '' },
    { id: 4, name: '86 Diamonds', price: 20500, sku: 'ML86', category: 'diamond', badge: '' },
    { id: 5, name: '172 Diamonds', price: 41000, sku: 'ML172', category: 'diamond', badge: '' },
    { id: 6, name: '257 Diamonds', price: 61500, sku: 'ML257', category: 'diamond', badge: '' },
    { id: 7, name: '706 Diamonds', price: 165000, sku: 'ML706', category: 'diamond', badge: '' },
    { id: 8, name: '2195 Diamonds', price: 495000, sku: 'ML2195', category: 'diamond', badge: '' }
];

function getProducts() {
    if (global.customProducts) return global.customProducts;
    try {
        if (fs.existsSync(TMP_FILE)) {
            const data = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
            global.customProducts = data;
            return data;
        }
    } catch (e) {}
    global.customProducts = defaultProducts;
    return defaultProducts;
}

function saveProducts(products) {
    global.customProducts = products;
    try {
        fs.writeFileSync(TMP_FILE, JSON.stringify(products, null, 2), 'utf8');
    } catch (e) {}
}

export default async function handler(req, res) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'sean123';

    // 1. GET: Diambil oleh halaman depan (index.html) & halaman admin
    if (req.method === 'GET') {
        const products = getProducts();
        return res.status(200).json({ success: true, products });
    }

    // 2. POST: Menyimpan perubahan harga/produk dari Admin
    if (req.method === 'POST') {
        const { password, action, products } = req.body;

        if (password !== adminPassword) {
            return res.status(401).json({ success: false, message: 'Password Admin salah!' });
        }

        // Cek Login saja
        if (action === 'login') {
            return res.status(200).json({ success: true, message: 'Login berhasil' });
        }

        // Reset ke harga awal
        if (action === 'reset') {
            saveProducts(defaultProducts);
            return res.status(200).json({ success: true, products: defaultProducts, message: 'Harga dikembalikan ke awal!' });
        }

        // Simpan daftar produk & harga baru
        if (Array.isArray(products)) {
            saveProducts(products);
            return res.status(200).json({
                success: true,
                products,
                message: 'Harga & Produk berhasil diperbarui!'
            });
        }

        return res.status(400).json({ success: false, message: 'Data produk tidak valid' });
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
}