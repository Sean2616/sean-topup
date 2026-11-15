export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const { userId, zoneId, nickname, item, price, paymentMethod, whatsapp } = req.body;

    // 1. Buat Nomor Invoice Unik (Contoh: SEAN-849201)
    const randomNum = Math.floor(100000 + Math.random() * 900000);
    const invoiceId = `SEAN-${randomNum}`;

    // 2. Tambahkan kode unik pembayaran (misal: 123 rupiah)
    const uniqueCode = Math.floor(10 + Math.random() * 90);
    const totalPrice = parseInt(price) + uniqueCode;

    // 3. Buat simulasi QR Code Pembayaran menggunakan API pembuat QR
    const qrData = `SEANTOPUP|${invoiceId}|${totalPrice}`;
    const qrImage = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}`;

    /* 
       CATATAN UNTUK PENGEMBANGANSELANJUTNYA:
       Di bagian inilah nantinya Anda bisa memasukkan API dari Tripay / Midtrans (untuk pembayaran asli)
       dan API dari Digiflazz / VipReseller (untuk pengiriman diamond otomatis).
    */

    // Simulasi jeda proses server 1 detik
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Kirim balasan ke Frontend
    return res.status(200).json({
        success: true,
        invoiceId: invoiceId,
        nickname: nickname,
        item: item,
        paymentMethod: paymentMethod,
        totalPrice: totalPrice,
        qrImage: qrImage,
        message: 'Pesanan berhasil dibuat di server Sean Top Up'
    });
}